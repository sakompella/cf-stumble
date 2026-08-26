import { expect, test } from "vitest";
import { parseSha } from "../../src/git/types.js";
import {
  MemoryValidationResultStore,
  type ValidationResult,
} from "../../src/validation/index.js";

const FIRST = parseSha("1111111111111111111111111111111111111111");
const SECOND = parseSha("2222222222222222222222222222222222222222");

function result(candidate: typeof FIRST, verdict: ValidationResult["verdict"]): ValidationResult {
  return {
    candidate,
    validatedAgainst: undefined,
    corpusVersion: "sha256:corpus",
    gateVersion: "sha256:gate",
    verdict,
    createdAt: 1,
    caseResults: [],
  };
}

test("validation results are keyed by candidate commit sha and queryable by verdict", async () => {
  const store = new MemoryValidationResultStore();
  const rejected = result(FIRST, "fail");
  const accepted = result(SECOND, "pass");

  await store.put(rejected);
  await store.put(accepted);

  expect(await store.get(FIRST)).toEqual(rejected);
  expect(await store.query({ verdict: "fail" })).toEqual([rejected]);
  expect(await store.query({ verdict: "pass" })).toEqual([accepted]);
  expect(await store.query()).toHaveLength(2);
});

test("writing a result for a commit sha replaces its previous result", async () => {
  const store = new MemoryValidationResultStore();
  await store.put(result(FIRST, "fail"));
  const replacement = result(FIRST, "inconclusive");

  await store.put(replacement);

  expect(await store.get(FIRST)).toEqual(replacement);
  expect(await store.query({ verdict: "fail" })).toEqual([]);
});
