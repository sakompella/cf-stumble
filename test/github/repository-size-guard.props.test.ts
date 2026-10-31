import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { afterAll, expect, test } from "vitest";
import {
  MAX_REPOSITORY_BLOB_BYTES,
  MAX_REPOSITORY_BLOB_COUNT,
  MAX_REPOSITORY_SIZE_KB,
} from "../../src/github/repository-size-guard.js";
import { PROJECT_CLONE_SIZE_FAILURE_EXIT_CODE } from "../../src/project-provision.js";
import {
  answered,
  blobs,
  clone,
  FAKE_TOKEN,
  printedAsIs,
  removeScratch,
  verdict,
  type Scenario,
} from "./size-guard-shell.js";

afterAll(removeScratch);

function expectedVerdict(
  measured: Readonly<{ sizeKb: number; blobCount: number; blobBytes: number; truncated: boolean }>,
): string {
  if (measured.truncated) return "tree-truncated";

  if (measured.blobCount > MAX_REPOSITORY_BLOB_COUNT) return "too-many-files";

  if (measured.blobBytes > MAX_REPOSITORY_BLOB_BYTES) return "working-tree-too-large";

  if (measured.sizeKb > MAX_REPOSITORY_SIZE_KB) return "repository-too-large";

  return "within-limits";
}

test("the in-workspace verdict follows the size policy", () => {
  hegel.test(
    (tc) => {
      const sizeKb = tc.draw(
        gs.oneOf(
          gs.integers({ minValue: 0, maxValue: 2 * MAX_REPOSITORY_SIZE_KB }),
          gs.sampledFrom([MAX_REPOSITORY_SIZE_KB, MAX_REPOSITORY_SIZE_KB + 1]),
        ),
      );

      const blobCount = tc.draw(
        gs.oneOf(
          gs.integers({ minValue: 1, maxValue: 50 }),
          gs.sampledFrom([MAX_REPOSITORY_BLOB_COUNT, MAX_REPOSITORY_BLOB_COUNT + 1]),
        ),
      );

      const blobBytes = tc.draw(
        gs.oneOf(
          gs.integers({ minValue: blobCount, maxValue: 2 * MAX_REPOSITORY_BLOB_BYTES }),
          gs.sampledFrom([MAX_REPOSITORY_BLOB_BYTES, MAX_REPOSITORY_BLOB_BYTES + 1]),
        ),
      );

      const truncated = tc.draw(gs.booleans());

      const shell = verdict({
        repository: answered({ size: sizeKb, default_branch: "feature/a b" }),
        tree: answered({ truncated, tree: [{ type: "tree" }, ...blobs(blobCount, blobBytes)] }),
      });

      expect(shell).toBe(expectedVerdict({ sizeKb, blobCount, blobBytes, truncated }));
    },
    { testCases: 12 },
  );
}, 30_000);

test.each([
  [
    "gh is missing",
    { gh: false, repository: answered({ size: 1, default_branch: "main" }), tree: answered({}) },
  ],
  [
    "the repository request fails",
    { repository: { exitCode: 1, body: "" }, tree: answered({ truncated: false, tree: [] }) },
  ],
  [
    "the tree request fails",
    {
      repository: answered({ size: 1, default_branch: "main" }),
      tree: { exitCode: 1, body: "" },
    },
  ],
  [
    "the repository answer is malformed",
    {
      repository: answered({ size: "large", default_branch: "main" }),
      tree: answered({ truncated: false, tree: [] }),
    },
  ],
  [
    "a blob size is malformed",
    {
      repository: answered({ size: 1, default_branch: "main" }),
      tree: answered({ truncated: false, tree: [{ type: "blob", size: "10" }] }),
    },
  ],
  [
    "the tree has no truncation flag",
    {
      repository: answered({ size: 1, default_branch: "main" }),
      tree: answered({ tree: [] }),
    },
  ],
  [
    "gh prints unfiltered JSON for the repository",
    {
      repository: printedAsIs(JSON.stringify({ size: 1, default_branch: "main" })),
      tree: answered({ truncated: false, tree: [] }),
    },
  ],
  [
    "gh prints an unknown word for the tree",
    { repository: answered({ size: 1, default_branch: "main" }), tree: printedAsIs("refuse\n") },
  ],
  [
    "gh prints a ceiling name followed by another line",
    {
      repository: answered({ size: 1, default_branch: "main" }),
      tree: printedAsIs("too-many-files\nwithin-limits\n"),
    },
  ],
  [
    "gh prints a size that is not plain digits",
    {
      repository: printedAsIs("5e+15 main\n"),
      tree: answered({ truncated: false, tree: [] }),
    },
  ],
] as const)("the verdict is unmeasured when %s", (_case, scenario: Scenario) => {
  expect(verdict(scenario)).toBe("unmeasured");
});

test("the clone step refuses an oversized repository before it clones", () => {
  const ran = clone({
    repository: answered({ size: 1, default_branch: "main" }),
    tree: answered({ truncated: false, tree: blobs(MAX_REPOSITORY_BLOB_COUNT + 1, 10_000) }),
  });

  expect(ran.status).toBe(PROJECT_CLONE_SIZE_FAILURE_EXIT_CODE);
  expect(ran.stderr).toContain("too-many-files");
  expect(ran.gitLog, "nothing was cloned").toBe("");
});

test("the clone step clones a repository within the limits", () => {
  const ran = clone({
    repository: answered({ size: 1, default_branch: "main" }),
    tree: answered({ truncated: false, tree: blobs(10, 1_000) }),
  });

  expect(ran.status, ran.stderr).toBe(0);
  expect(ran.gitLog).toBe("clone\n");
});

test("the clone step still clones when GitHub cannot be measured", () => {
  const ran = clone({ repository: { exitCode: 1, body: "" }, tree: { exitCode: 1, body: "" } });

  expect(ran.status, ran.stderr).toBe(0);
  expect(ran.gitLog).toBe("clone\n");
  expect(ran.stderr, "gh's error text never reaches the clone step's output").not.toContain(
    FAKE_TOKEN,
  );
});

test("an existing clone is neither measured nor recloned", () => {
  const ran = clone({
    existingClone: true,
    repository: answered({ size: 1, default_branch: "main" }),
    tree: answered({ truncated: false, tree: blobs(MAX_REPOSITORY_BLOB_COUNT + 1, 10_000) }),
  });

  expect(ran.status, ran.stderr).toBe(0);
  expect(ran.ghLog).toBe("");
  expect(ran.gitLog).toBe("");
});
