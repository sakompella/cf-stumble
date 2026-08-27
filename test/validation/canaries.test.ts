import { Result } from "better-result";
import { expect, test } from "vitest";
import { parseGenerationNumber } from "../../src/generation/types.js";
import { assertNever, parseSha } from "../../src/git/types.js";
import type { ReplayOutcome, ReplaySession } from "../../src/replay/index.js";
import {
  MemoryValidationResultStore,
  ValidationGate,
  computeCorpusVersion,
  type PinnedCanary,
  type ValidationCase,
} from "../../src/validation/index.js";
import { expectOk } from "../support/result.js";

const LIVE = parseSha("1111111111111111111111111111111111111111");
const CANDIDATE = parseSha("2222222222222222222222222222222222222222");
const validationIdentity = {
  generation: parseGenerationNumber(1),
  artifactDigest: CANDIDATE,
  validatedAgainstGeneration: parseGenerationNumber(0),
} as const;

const session: ReplaySession = {
  schemaVersion: 1,
  name: "canary-case",
  seed: 1,
  clock: { nowMs: 1_700_000_000_000 },
  initialWorkspace: [],
  turns: [],
  expectedEffects: { trace: [], finalWorkspace: [] },
};

function validationCase(name: string, mandatoryCanary: boolean): ValidationCase {
  return { name, session: { ...session, name }, mandatoryCanary };
}

function outcome(status: ReplayOutcome["status"]): ReplayOutcome {
  switch (status) {
    case "PASS":
      return { status, effects: { trace: [], finalWorkspace: [] } };
    case "FAIL":
      return {
        status,
        effects: { trace: [], finalWorkspace: [] },
        difference: { kind: "trace", index: 0, expected: undefined, actual: undefined },
      };
    case "INCONCLUSIVE":
      return {
        status,
        reason: "tape-exhausted",
        detail: "test tape is exhausted",
        effects: { trace: [], finalWorkspace: [] },
      };
    default:
      return assertNever(status, "replay outcome status");
  }
}

function makeGate(
  corpus: readonly ValidationCase[],
  execute: (generation: typeof LIVE | undefined, current: ReplaySession) => Promise<ReplayOutcome>,
  pinnedCanaries: readonly PinnedCanary[] = corpus
    .filter((corpusCase) => corpusCase.mandatoryCanary)
    .map(({ name: caseName, session: caseSession }) => ({
      name: caseName,
      session: caseSession,
    })),
  executorTimeoutMs = 30_000,
): ValidationGate {
  return new ValidationGate({
    pointerStore: {
      readPointer: () => Promise.resolve(Result.ok(LIVE)),
      setPointer: () => Promise.resolve(Result.ok(false)),
    },
    resultStore: new MemoryValidationResultStore(),
    corpus,
    pinnedCanaries,
    execute,
    executorTimeoutMs,
    now: () => 10,
  });
}

test("a candidate that removes the canary catching its own regression cannot promote", async () => {
  const stable = validationCase("stable", false);
  const canary = validationCase("self-protecting canary", true);
  const gate = makeGate(
    [stable],
    (_generation, current) =>
      Promise.resolve(current.name === canary.name ? outcome("FAIL") : outcome("PASS")),
    [{ name: canary.name, session: canary.session }],
  );

  const run = expectOk(await gate.validate(CANDIDATE, validationIdentity));

  expect(run.result.corpusVersion).toBe(await computeCorpusVersion([stable]));
  expect(run.result.verdict).toBe("inconclusive");
  expect(run.attestation).toBeUndefined();
});

test("a candidate that weakens a canary cannot promote", async () => {
  const canary = validationCase("strict canary", true);
  const weakened: ValidationCase = {
    ...canary,
    session: {
      ...canary.session,
      expectedEffects: { trace: [], finalWorkspace: [{ path: "extra.txt", content: "allowed" }] },
    },
  };
  const gate = makeGate([weakened], () => Promise.resolve(outcome("PASS")), [
    { name: canary.name, session: canary.session },
  ]);

  const run = expectOk(await gate.validate(CANDIDATE, validationIdentity));

  expect(run.result.verdict).toBe("inconclusive");
  expect(run.attestation).toBeUndefined();
});

test("a candidate cannot demote a pinned canary through corpus metadata", async () => {
  const canary = validationCase("pinned canary", true);
  const demoted: ValidationCase = { ...canary, mandatoryCanary: false };
  const gate = makeGate([demoted], () => Promise.resolve(outcome("PASS")), [
    { name: canary.name, session: canary.session },
  ]);

  const run = expectOk(await gate.validate(CANDIDATE, validationIdentity));

  expect(run.result.verdict).toBe("inconclusive");
  expect(run.attestation).toBeUndefined();
});

test("partial canary success does not promote because every required canary must pass individually", async () => {
  const first = validationCase("first canary", true);
  const second = validationCase("second canary", true);
  const gate = makeGate([first, second], (generation, current) =>
    Promise.resolve(
      generation === LIVE || current.name === first.name ? outcome("PASS") : outcome("FAIL"),
    ),
  );

  const run = expectOk(await gate.validate(CANDIDATE, validationIdentity));

  expect(run.result.verdict).toBe("fail");
  expect(run.attestation).toBeUndefined();
});

test("a throwing scorer yields INCONCLUSIVE rather than PASS", async () => {
  const gate = makeGate([validationCase("throwing scorer", false)], () =>
    Promise.reject(new Error("scorer crashed")),
  );

  const run = expectOk(await gate.validate(CANDIDATE, validationIdentity));

  expect(run.result.verdict).toBe("inconclusive");
  expect(run.result.caseResults[0]?.baseline).toMatchObject({
    status: "INCONCLUSIVE",
    reason: "agent-error",
  });
  expect(run.attestation).toBeUndefined();
});

test("a timing-out executor yields INCONCLUSIVE rather than PASS", async () => {
  const gate = makeGate(
    [validationCase("timing out executor", false)],
    () => new Promise<ReplayOutcome>(() => {}),
    [],
    1,
  );

  const run = expectOk(await gate.validate(CANDIDATE, validationIdentity));

  expect(run.result.verdict).toBe("inconclusive");
  expect(run.result.caseResults[0]?.baseline).toMatchObject({
    status: "INCONCLUSIVE",
    reason: "timeout",
  });
  expect(run.attestation).toBeUndefined();
});

test("a failing mandatory canary blocks even when that canary failed on live", async () => {
  const stable = validationCase("stable", false);
  const canary = validationCase("mandatory", true);
  const gate = makeGate([stable, canary], (generation, current) =>
    Promise.resolve(
      current.name === "stable"
        ? outcome("PASS")
        : generation === LIVE
          ? outcome("FAIL")
          : outcome("FAIL"),
    ),
  );

  const run = expectOk(await gate.validate(CANDIDATE, validationIdentity));

  expect(run.result.verdict).toBe("fail");
  expect(run.attestation).toBeUndefined();
});

test("a canary that cannot pass on live makes the gate inconclusive", async () => {
  const stable = validationCase("stable", false);
  const canary = validationCase("mandatory", true);
  const gate = makeGate([stable, canary], (generation, current) =>
    Promise.resolve(
      current.name === "stable"
        ? outcome("PASS")
        : generation === LIVE
          ? outcome("FAIL")
          : outcome("PASS"),
    ),
  );

  const run = expectOk(await gate.validate(CANDIDATE, validationIdentity));

  expect(run.result.verdict).toBe("inconclusive");
  expect(run.attestation).toBeUndefined();
});

test("an empty corpus is inconclusive rather than vacuously passing", async () => {
  const gate = makeGate([], () => Promise.resolve(outcome("PASS")));

  const run = expectOk(await gate.validate(CANDIDATE, validationIdentity));

  expect(run.result.verdict).toBe("inconclusive");
  expect(run.attestation).toBeUndefined();
});

test("an all-failing baseline is inconclusive rather than permitting promotion", async () => {
  const gate = makeGate([validationCase("known defect", false)], () =>
    Promise.resolve(outcome("FAIL")),
  );

  const run = expectOk(await gate.validate(CANDIDATE, validationIdentity));

  expect(run.result.verdict).toBe("inconclusive");
  expect(run.attestation).toBeUndefined();
});

test("an inconclusive case cannot silently count as a pass", async () => {
  const gate = makeGate([validationCase("unstable", false)], (generation) =>
    Promise.resolve(generation === LIVE ? outcome("PASS") : outcome("INCONCLUSIVE")),
  );

  const run = expectOk(await gate.validate(CANDIDATE, validationIdentity));

  expect(run.result.verdict).toBe("inconclusive");
  expect(run.result.caseResults[0]?.candidate.status).toBe("INCONCLUSIVE");
  expect(run.attestation).toBeUndefined();
});
