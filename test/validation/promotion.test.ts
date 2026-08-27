import { expect, test } from "vitest";
import { expectOk } from "../support/result.js";
import { parseGenerationNumber } from "../../src/generation/types.js";
import { PointerManager } from "../../src/pointer/index.js";
import { parseSha } from "../../src/git/types.js";
import type { ReplayOutcome, ReplaySession } from "../../src/replay/index.js";
import {
  MemoryValidationResultStore,
  ValidationGate,
  type ValidationCase,
} from "../../src/validation/index.js";
import { MemoryStore } from "../../src/storage/memory.js";

const LIVE = parseSha("1111111111111111111111111111111111111111");
const CANDIDATE = parseSha("2222222222222222222222222222222222222222");
const MOVED_LIVE = parseSha("3333333333333333333333333333333333333333");

const session: ReplaySession = {
  schemaVersion: 1,
  name: "promotion-case",
  seed: 1,
  clock: { nowMs: 1_700_000_000_000 },
  initialWorkspace: [],
  turns: [],
  expectedEffects: { trace: [], finalWorkspace: [] },
};

const validationCase: ValidationCase = {
  name: "promotion case",
  session,
  mandatoryCanary: true,
};

const pass: ReplayOutcome = {
  status: "PASS",
  effects: { trace: [], finalWorkspace: [] },
};

test("promote rejects a passing attestation after the observed live pointer moved", async () => {
  const store = new MemoryStore();
  expect(expectOk(await store.setPointer(LIVE, undefined))).toBe(true);
  const gate = new ValidationGate({
    pointerStore: store,
    resultStore: new MemoryValidationResultStore(),
    corpus: [validationCase],
    pinnedCanaries: [{ name: validationCase.name, session }],
    execute: () => Promise.resolve(pass),
    now: () => 456,
  });

  const validation = expectOk(
    await gate.validate(CANDIDATE, {
      generation: parseGenerationNumber(1),
      artifactDigest: CANDIDATE,
      validatedAgainstGeneration: parseGenerationNumber(0),
    }),
  );
  if (validation.attestation === undefined) {
    throw new Error("passing validation did not emit an attestation");
  }
  expect(validation.attestation.validatedAgainst).toBe(LIVE);

  expect(expectOk(await store.setPointer(MOVED_LIVE, LIVE))).toBe(true);
  const pointer = new PointerManager({
    store,
    corpusVersion: validation.result.corpusVersion,
    gateVersion: validation.result.gateVersion,
  });

  const promotion = expectOk(await pointer.promote(CANDIDATE, validation.attestation));

  expect(promotion).toEqual({
    outcome: "rejected",
    reason: {
      kind: "stale-attestation",
      validatedAgainst: LIVE,
      liveNow: MOVED_LIVE,
    },
  });
  expect(expectOk(await store.readPointer())).toBe(MOVED_LIVE);
});
