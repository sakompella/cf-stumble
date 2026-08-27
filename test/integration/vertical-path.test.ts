import { expect, test } from "vitest";
import { expectOk } from "../support/result.js";
import {
  assertGenesisReachable,
  makeGenesisPin,
  resetToGenesis,
} from "../../src/generation/genesis.js";
import { readGeneration } from "../../src/generation/read.js";
import { PointerManager } from "../../src/pointer/index.js";
import { InMemoryWorkspace, parseWorkspacePath } from "../../src/tools/index.js";
import { runPinnedTurn } from "../../src/integration/turn.js";
import {
  ALLOW_POLICY,
  buildChild,
  buildPromptCandidate,
  loadFixture,
  runConfiguredTurn,
  seedStore,
} from "./fixtures.js";
import { requireAttestation, validateCandidate } from "./gate.js";

test("seeding starts generation 0, pins its turn, and builds a distinct candidate", async () => {
  const { store, genesis } = await seedStore();
  expect(expectOk(await store.readPointer())).toBe(genesis.sha);

  const workspace = new InMemoryWorkspace({
    files: [{ path: "turns.log", content: "" }],
  });
  const firstTurn = await runConfiguredTurn(store, workspace);

  expect(firstTurn.generation).toBe(genesis.sha);
  expect(firstTurn.result.generation.sha).toBe(genesis.sha);
  expect(firstTurn.result.write).toMatchObject({ kind: "write" });

  const candidate = await buildChild(
    store,
    genesis,
    "candidate prompt\n",
    ALLOW_POLICY,
    "change prompt",
  );

  expect(candidate.parent).toBe(genesis.sha);
  expect(candidate.sha).not.toBe(genesis.sha);
  expect(expectOk(await store.readPointer())).toBe(genesis.sha);
});

test("promotion changes the next pinned turn and rollback restores generation 0", async () => {
  const { store, genesis } = await seedStore();
  const workspace = new InMemoryWorkspace({ files: [{ path: "turns.log", content: "" }] });
  await runConfiguredTurn(store, workspace);
  const objectsAfterGenesis = expectOk(await store.listObjects());
  const candidate = await buildPromptCandidate(store, genesis);
  const objectsAfterCandidate = expectOk(await store.listObjects());
  expect(objectsAfterGenesis).toHaveLength(4);
  expect(objectsAfterCandidate).toHaveLength(7);
  const validation = await validateCandidate(store, candidate, await loadFixture());
  expect(validation.run.result.verdict).toBe("pass");
  expect(validation.run.result.caseResults[0]).toMatchObject({
    baseline: { status: "PASS" },
    candidate: { status: "PASS" },
  });
  expect(await validation.resultStore.get(validation.run.result.generation)).toEqual(
    validation.run.result,
  );

  const pointer = new PointerManager({
    store,
    corpusVersion: validation.run.result.corpusVersion,
    gateVersion: validation.run.result.gateVersion,
  });
  expect(
    expectOk(await pointer.promote(candidate.sha, requireAttestation(validation.run))),
  ).toEqual({
    outcome: "promoted",
    from: genesis.sha,
    to: candidate.sha,
  });

  const candidateTurn = await runConfiguredTurn(store, workspace);
  expect(candidateTurn.generation).toBe(candidate.sha);
  expect(candidateTurn.result.generation.parent).toBe(genesis.sha);
  await expect(workspace.readFile(parseWorkspacePath("turns.log").unwrap())).resolves.toBe(
    "candidate prompt\nturn\n",
  );

  expect(expectOk(await pointer.rollback(genesis.sha, candidate.sha))).toEqual({
    outcome: "promoted",
    from: candidate.sha,
    to: genesis.sha,
  });
  const restoredTurn = await runConfiguredTurn(store, workspace);
  expect(restoredTurn.generation).toBe(genesis.sha);
  await expect(workspace.readFile(parseWorkspacePath("turns.log").unwrap())).resolves.toBe(
    "stable prompt\nturn\n",
  );
});

test("a promotion does not migrate a turn that already pinned generation 0", async () => {
  const { store, genesis } = await seedStore();
  const candidate = await buildChild(
    store,
    genesis,
    "candidate prompt\n",
    ALLOW_POLICY,
    "change prompt",
  );
  const validation = await validateCandidate(store, candidate, await loadFixture());
  const pointer = new PointerManager({
    store,
    corpusVersion: validation.run.result.corpusVersion,
    gateVersion: validation.run.result.gateVersion,
  });

  let announceStart: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    announceStart = resolve;
  });
  let allowFinish: (() => void) | undefined;
  const finish = new Promise<void>((resolve) => {
    allowFinish = resolve;
  });
  const inFlight = runPinnedTurn(store, async (generation) => {
    const start = announceStart;
    if (start === undefined) {
      throw new Error("turn did not initialize its start signal");
    }
    start();
    await finish;
    return expectOk(await readGeneration(store, generation));
  });

  await started;
  expect(
    expectOk(await pointer.promote(candidate.sha, requireAttestation(validation.run))).outcome,
  ).toBe("promoted");
  expect(expectOk(await store.readPointer())).toBe(candidate.sha);
  const release = allowFinish;
  if (release === undefined) {
    throw new Error("turn did not initialize its finish signal");
  }
  release();

  const completed = await inFlight;
  expect(completed.generation).toBe(genesis.sha);
  expect(completed.result.generation.sha).toBe(genesis.sha);
  expect((await runConfiguredTurn(store, new InMemoryWorkspace())).generation).toBe(candidate.sha);
});

test("rollback leaves accumulated context, facts, corpus, and validation evidence intact", async () => {
  const { store, genesis } = await seedStore();
  const candidate = await buildChild(
    store,
    genesis,
    "candidate prompt\n",
    ALLOW_POLICY,
    "change prompt",
  );
  const validation = await validateCandidate(store, candidate, await loadFixture());
  const accumulated = {
    conversationHistory: ["user asked for a change"],
    learnedFacts: new Map([["answer", "42"]]),
    corpusEntries: [...validation.corpus],
  };
  const pointer = new PointerManager({
    store,
    corpusVersion: validation.run.result.corpusVersion,
    gateVersion: validation.run.result.gateVersion,
  });
  expect(
    expectOk(await pointer.promote(candidate.sha, requireAttestation(validation.run))).outcome,
  ).toBe("promoted");
  accumulated.conversationHistory.push("agent changed the prompt");
  accumulated.learnedFacts.set("status", "tested");
  accumulated.corpusEntries.push({
    name: "later corpus entry",
    session: await loadFixture(),
    mandatoryCanary: false,
  });
  const evidence = await validation.resultStore.get(validation.run.result.generation);

  expect(expectOk(await pointer.rollback(genesis.sha, candidate.sha)).outcome).toBe("promoted");
  expect(accumulated.conversationHistory).toEqual([
    "user asked for a change",
    "agent changed the prompt",
  ]);
  expect(accumulated.learnedFacts).toEqual(
    new Map([
      ["answer", "42"],
      ["status", "tested"],
    ]),
  );
  expect(accumulated.corpusEntries.map((entry) => entry.name)).toEqual([
    "four primitives remain executable",
    "later corpus entry",
  ]);
  expect(await validation.resultStore.get(validation.run.result.generation)).toEqual(evidence);
});

test("a candidate that fails the real replay gate leaves the live pointer unchanged", async () => {
  const { store, genesis } = await seedStore();
  const brokenCandidate = await buildChild(
    store,
    genesis,
    "candidate prompt\n",
    "deny-write\n",
    "deny writes",
  );
  const validation = await validateCandidate(store, brokenCandidate, await loadFixture());

  expect(validation.run.result.verdict).toBe("fail");
  expect(validation.run.attestation).toBeUndefined();
  expect(validation.run.result.caseResults[0]).toMatchObject({
    baseline: { status: "PASS" },
    candidate: { status: "FAIL" },
  });
  expect(expectOk(await store.readPointer())).toBe(genesis.sha);
});

test("reset bypasses a broken candidate and every built descendant still reaches pinned genesis", async () => {
  const { store, genesis } = await seedStore();
  const candidate = await buildChild(
    store,
    genesis,
    "candidate prompt\n",
    ALLOW_POLICY,
    "change prompt",
  );
  const brokenCandidate = await buildChild(
    store,
    candidate,
    "broken prompt\n",
    "deny-write\n",
    "broken policy",
  );
  expect(expectOk(await store.setPointer(brokenCandidate.sha, genesis.sha))).toBe(true);
  await expect(runConfiguredTurn(store, new InMemoryWorkspace())).rejects.toThrow(
    "unsupported turn policy",
  );

  const pin = makeGenesisPin(genesis);
  expectOk(await assertGenesisReachable(store, genesis.sha, pin));
  expectOk(await assertGenesisReachable(store, candidate.sha, pin));
  expectOk(await assertGenesisReachable(store, brokenCandidate.sha, pin));

  expect(expectOk(await resetToGenesis(store, pin))).toEqual({
    outcome: "reset",
    from: brokenCandidate.sha,
    to: genesis.sha,
  });
  expect(expectOk(await store.readPointer())).toBe(genesis.sha);
  expect((await runConfiguredTurn(store, new InMemoryWorkspace())).generation).toBe(genesis.sha);
});
