import { expect, test } from "vitest";
import { parseSha } from "../../src/git/types.js";
import { parseGenerationNumber } from "../../src/generation/types.js";
import { MemoryValidationResultStore, type ValidationResult } from "../../src/validation/index.js";

const FIRST = parseSha("1111111111111111111111111111111111111111");
const SECOND = parseSha("2222222222222222222222222222222222222222");

function result(
  candidate: typeof FIRST,
  verdict: ValidationResult["verdict"],
  generation = candidate === FIRST ? 1 : 2,
): ValidationResult {
  return {
    candidate,
    generation: parseGenerationNumber(generation),
    artifactDigest: candidate,
    validatedAgainst: undefined,
    validatedAgainstGeneration: undefined,
    corpusVersion: "sha256:corpus",
    gateVersion: "sha256:gate",
    verdict,
    createdAt: 1,
    caseResults: [],
  };
}

test("validation results are keyed by generation and queryable by verdict", async () => {
  const store = new MemoryValidationResultStore();
  const rejected = result(FIRST, "fail");
  const accepted = result(SECOND, "pass");

  await store.put(rejected);
  await store.put(accepted);

  expect(await store.get(rejected.generation)).toEqual(rejected);
  expect(await store.query({ verdict: "fail" })).toEqual([rejected]);
  expect(await store.query({ verdict: "pass" })).toEqual([accepted]);
  expect(await store.query()).toHaveLength(2);
});

test("two attempts for one commit keep separate validation results", async () => {
  const store = new MemoryValidationResultStore();
  const firstAttempt = result(FIRST, "fail", 1);
  const secondAttempt = result(FIRST, "pass", 2);

  await store.put(firstAttempt);
  await store.put(secondAttempt);

  expect(await store.get(firstAttempt.generation)).toEqual(firstAttempt);
  expect(await store.get(secondAttempt.generation)).toEqual(secondAttempt);
  expect(await store.query({ candidate: FIRST })).toEqual([firstAttempt, secondAttempt]);
});

test("writing a result for a generation replaces its previous result", async () => {
  const store = new MemoryValidationResultStore();
  await store.put(result(FIRST, "fail"));
  const replacement = result(FIRST, "inconclusive");

  await store.put(replacement);

  expect(await store.get(replacement.generation)).toEqual(replacement);
  expect(await store.query({ verdict: "fail" })).toEqual([]);
});
