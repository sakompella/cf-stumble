import { expect, test } from "vitest";
import { assertNever, parseSha } from "../../src/git/types.js";
import type { ReplayOutcome, ReplaySession } from "../../src/replay/index.js";
import {
  MemoryValidationResultStore,
  ValidationGate,
  type ValidationCase,
} from "../../src/validation/index.js";

const LIVE = parseSha("1111111111111111111111111111111111111111");
const CANDIDATE = parseSha("2222222222222222222222222222222222222222");

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
  execute: (
    generation: typeof LIVE | undefined,
    current: ReplaySession,
  ) => Promise<ReplayOutcome>,
): ValidationGate {
  return new ValidationGate({
    pointerStore: {
      readPointer: () => Promise.resolve(LIVE),
      setPointer: () => Promise.resolve(false),
    },
    resultStore: new MemoryValidationResultStore(),
    corpus,
    execute,
    now: () => 10,
  });
}

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

  const run = await gate.validate(CANDIDATE);

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

  const run = await gate.validate(CANDIDATE);

  expect(run.result.verdict).toBe("inconclusive");
  expect(run.attestation).toBeUndefined();
});

test("an empty corpus is inconclusive rather than vacuously passing", async () => {
  const gate = makeGate([], () => Promise.resolve(outcome("PASS")));

  const run = await gate.validate(CANDIDATE);

  expect(run.result.verdict).toBe("inconclusive");
  expect(run.attestation).toBeUndefined();
});

test("an all-failing baseline is inconclusive rather than permitting promotion", async () => {
  const gate = makeGate(
    [validationCase("known defect", false)],
    () => Promise.resolve(outcome("FAIL")),
  );

  const run = await gate.validate(CANDIDATE);

  expect(run.result.verdict).toBe("inconclusive");
  expect(run.attestation).toBeUndefined();
});

test("an inconclusive case cannot silently count as a pass", async () => {
  const gate = makeGate([validationCase("unstable", false)], (generation) =>
    Promise.resolve(generation === LIVE ? outcome("PASS") : outcome("INCONCLUSIVE")),
  );

  const run = await gate.validate(CANDIDATE);

  expect(run.result.verdict).toBe("inconclusive");
  expect(run.result.caseResults[0]?.candidate.status).toBe("INCONCLUSIVE");
  expect(run.attestation).toBeUndefined();
});
