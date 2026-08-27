import { Result } from "better-result";
import { expect, test } from "vitest";
import { parseGenerationNumber } from "../../src/generation/types.js";
import { parseSha } from "../../src/git/types.js";
import type { ReplayOutcome, ReplaySession } from "../../src/replay/index.js";
import {
  MemoryValidationResultStore,
  ValidationGate,
  type ValidationCase,
} from "../../src/validation/index.js";
import { expectOk } from "../support/result.js";

const LIVE = parseSha("1111111111111111111111111111111111111111");
const CANDIDATE = parseSha("2222222222222222222222222222222222222222");

const session: ReplaySession = {
  schemaVersion: 1,
  name: "executor-case",
  seed: 1,
  clock: { nowMs: 1_700_000_000_000 },
  initialWorkspace: [],
  turns: [],
  expectedEffects: { trace: [], finalWorkspace: [] },
};

const regressionCase: ValidationCase = {
  name: "executor remains compatible",
  session,
  mandatoryCanary: false,
};

const knownDefectCase: ValidationCase = {
  name: "known defect remains visible",
  session: { ...session, name: "known defect remains visible" },
  mandatoryCanary: false,
};

function pass(): ReplayOutcome {
  return { status: "PASS", effects: { trace: [], finalWorkspace: [] } };
}

function fail(): ReplayOutcome {
  return {
    status: "FAIL",
    effects: { trace: [], finalWorkspace: [] },
    difference: { kind: "trace", index: 0, expected: undefined, actual: undefined },
  };
}

test("the ratchet blocks a regression from a live passing case", async () => {
  const results = new MemoryValidationResultStore();
  const gate = new ValidationGate({
    pointerStore: {
      readPointer: () => Promise.resolve(Result.ok(LIVE)),
      setPointer: () => Promise.resolve(Result.ok(false)),
    },
    resultStore: results,
    corpus: [regressionCase],
    execute: (generation) => Promise.resolve(generation === LIVE ? pass() : fail()),
    now: () => 10,
  });

  const run = expectOk(
    await gate.validate(CANDIDATE, {
      generation: parseGenerationNumber(1),
      artifactDigest: CANDIDATE,
      validatedAgainstGeneration: parseGenerationNumber(0),
    }),
  );

  expect(run.result.verdict).toBe("fail");
  expect(run.attestation).toBeUndefined();
  expect(run.result.caseResults[0]?.candidate.status).toBe("FAIL");
});

test("the ratchet allows a case that was already failing to fail again", async () => {
  const results = new MemoryValidationResultStore();
  const gate = new ValidationGate({
    pointerStore: {
      readPointer: () => Promise.resolve(Result.ok(LIVE)),
      setPointer: () => Promise.resolve(Result.ok(false)),
    },
    resultStore: results,
    corpus: [regressionCase, knownDefectCase],
    execute: (_generation, current) =>
      Promise.resolve(current.name === session.name ? pass() : fail()),
    now: () => 10,
  });

  const run = expectOk(
    await gate.validate(CANDIDATE, {
      generation: parseGenerationNumber(1),
      artifactDigest: CANDIDATE,
      validatedAgainstGeneration: parseGenerationNumber(0),
    }),
  );

  expect(run.result.verdict).toBe("pass");
  expect(run.attestation).toMatchObject({ candidate: CANDIDATE, verdict: "pass" });
});
