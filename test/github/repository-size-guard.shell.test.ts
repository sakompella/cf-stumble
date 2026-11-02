import { afterAll, expect, test } from "vitest";
import { answered, blobs, clone, removeScratch } from "./size-guard-shell.js";

afterAll(removeScratch);

test("the size check asks gh for the repository's API path and its branch tree, and passes no credential", () => {
  const ran = clone({
    repository: answered({ size: 1, default_branch: "main" }),
    tree: answered({ truncated: false, tree: blobs(1, 1_000) }),
  });

  const calls = ran.ghLog.trim().split("\n");

  expect(ran.status, ran.stderr).toBe(0);
  expect(calls.map((call) => call.split(" ")[0])).toEqual(["api", "api"]);
  expect(calls.map((call) => call.split(" ")[1])).toEqual([
    "repos/sample/repo-1",
    "repos/sample/repo-1/git/trees/main?recursive=1",
  ]);
  expect(ran.ghLog).not.toMatch(/token|authorization/iu);
});
