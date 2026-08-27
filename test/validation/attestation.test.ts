import { Result } from "better-result";
import { expect, test } from "vitest";
import { parseGenerationNumber } from "../../src/generation/types.js";
import { parseSha } from "../../src/git/types.js";
import type { ReplayOutcome, ReplaySession } from "../../src/replay/index.js";
import {
  MemoryValidationResultStore,
  ValidationGate,
  computeCorpusVersion,
  computeGateVersion,
  type ValidationCase,
} from "../../src/validation/index.js";
import { expectOk } from "../support/result.js";

const LIVE = parseSha("1111111111111111111111111111111111111111");
const CANDIDATE = parseSha("2222222222222222222222222222222222222222");

const session: ReplaySession = {
  schemaVersion: 1,
  name: "passing-case",
  seed: 1,
  clock: { nowMs: 1_700_000_000_000 },
  initialWorkspace: [],
  turns: [],
  expectedEffects: { trace: [], finalWorkspace: [] },
};

const validationCase: ValidationCase = {
  name: "passing case",
  session,
  mandatoryCanary: true,
};

const passingOutcome: ReplayOutcome = {
  status: "PASS",
  effects: { trace: [], finalWorkspace: [] },
};

test("a passing run emits an attestation bound to its observed live generation", async () => {
  const gate = new ValidationGate({
    pointerStore: {
      readPointer: () => Promise.resolve(Result.ok(LIVE)),
      setPointer: () => Promise.resolve(Result.ok(false)),
    },
    resultStore: new MemoryValidationResultStore(),
    corpus: [validationCase],
    pinnedCanaries: [{ name: validationCase.name, session }],
    execute: () => Promise.resolve(passingOutcome),
    now: () => 123,
  });

  const run = expectOk(
    await gate.validate(CANDIDATE, {
      generation: parseGenerationNumber(1),
      artifactDigest: CANDIDATE,
      validatedAgainstGeneration: parseGenerationNumber(0),
    }),
  );

  expect(run.result.verdict).toBe("pass");
  expect(run.attestation).toEqual({
    candidate: CANDIDATE,
    generation: 1,
    artifactDigest: CANDIDATE,
    validatedAgainst: LIVE,
    validatedAgainstGeneration: 0,
    corpusVersion: run.result.corpusVersion,
    gateVersion: run.result.gateVersion,
    verdict: "pass",
    createdAt: 123,
  });
});

test("corpus versions change when case content or canary markings change", async () => {
  const baseline = await computeCorpusVersion([validationCase]);
  const changedSession = await computeCorpusVersion([
    { ...validationCase, session: { ...session, seed: 2 } },
  ]);
  const changedCanary = await computeCorpusVersion([{ ...validationCase, mandatoryCanary: false }]);

  expect(changedSession).not.toBe(baseline);
  expect(changedCanary).not.toBe(baseline);
  expect(await computeCorpusVersion([validationCase])).toBe(baseline);
});

test("the gate version is a content-derived stable hash", async () => {
  const first = await computeGateVersion();
  const second = await computeGateVersion();

  expect(first).toBe(second);
  expect(first).toMatch(/^sha256:[0-9a-f]{64}$/u);
});
