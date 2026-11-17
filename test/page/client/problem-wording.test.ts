import { expect, test } from "vitest";
import { refusalText } from "../../../src/page/client/api.js";
import { MAX_REPOSITORY_BLOB_COUNT } from "../../../src/repository-limits.js";

test("a refusal the page knows is one sentence, not the code", () => {
  const typo = refusalText({ kind: "problem", code: "repository-not-accessible" });

  expect(typo).not.toContain("repository-not-accessible");
  expect(typo).toMatch(/typo/u);
  expect(refusalText({ kind: "error", code: "internal-error" })).not.toContain("internal-error");
});

test("a repository that is too large says the limits", () => {
  expect(refusalText({ kind: "problem", code: "repository-too-large" })).toContain(
    MAX_REPOSITORY_BLOB_COUNT.toLocaleString("en-US"),
  );
});

test("a code from a newer Worker still shows its name", () => {
  expect(refusalText({ kind: "problem", code: "brand-new-code" })).toBe("rejected: brand-new-code");
  expect(refusalText({ kind: "error", code: "brand-new-code" })).toBe("error: brand-new-code");
});
