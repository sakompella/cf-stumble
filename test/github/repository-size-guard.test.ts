import { expect, test } from "vitest";
import { repositorySizeVerdictSource } from "../../src/github/repository-size-guard.js";
import { parsePublicRepositoryUrl } from "../../src/project-catalog.js";
import {
  PROJECT_CLONE_SIZE_FAILURE_EXIT_CODE,
  projectCloneSource,
} from "../../src/project-provision.js";
import { sampleProjectOne } from "../project-fixtures.js";

test("a new clone is measured after the existing-clone check and before git clone", () => {
  const source = projectCloneSource(sampleProjectOne);
  const existingCheck = source.indexOf("rev-parse --is-bare-repository");
  const measured = source.indexOf('size_verdict="$(repository_size_verdict)"');
  const cloned = source.indexOf("git clone");

  expect(existingCheck).toBeGreaterThanOrEqual(0);
  expect(measured).toBeGreaterThan(existingCheck);
  expect(cloned).toBeGreaterThan(measured);
  const decision = source.slice(measured, cloned);

  expect(decision).toContain(`exit ${PROJECT_CLONE_SIZE_FAILURE_EXIT_CODE}`);
  expect(decision, "only a named ceiling refuses").toContain(
    "    tree-truncated | too-many-files | working-tree-too-large | repository-too-large)",
  );
  expect(decision, "no catch-all arm can refuse an unexpected verdict").not.toContain("*)");
});

test("the size check asks gh for the repository's API path and carries no credential", () => {
  const repository = parsePublicRepositoryUrl("https://github.com/Owner/a.b");

  if (repository === undefined) throw new Error("the sample URL must parse");

  const source = repositorySizeVerdictSource(repository);

  expect(source).toContain("api 'repos/Owner/a.b' --jq");
  expect(source).toContain("'repos/Owner/a.b/git/trees/'\"$branch\"'?recursive=1'");
  expect(source).not.toMatch(/GH_TOKEN|authorization|auth token/iu);
});
