import { expect, test } from "vitest";
import { repositorySizeVerdictSource } from "../../src/github/repository-size-guard.js";
import { parsePublicRepositoryUrl } from "../../src/project-catalog.js";
import {
  PROJECT_CLONE_SIZE_FAILURE_EXIT_CODE,
  planProjectProvision,
  projectProvisionConfiguration,
  projectProvisionStep,
} from "../../src/project-provision.js";
import { sampleProjectOne } from "../project-fixtures.js";

/**
 * Workers-side coverage of the planned size check. These tests read shell text; the sibling
 * property file runs that text under `/bin/sh` with stub `gh` and `git` commands.
 */

function cloneSource(): string {
  const step = projectProvisionStep(
    planProjectProvision(projectProvisionConfiguration(sampleProjectOne.id), sampleProjectOne),
    "clone",
  );

  if (step.name !== "clone") throw new Error("the clone step must be the command step");

  return step.source;
}

test("a new clone is measured after the existing-clone check and before git clone", () => {
  const source = cloneSource();
  const existingCheck = source.indexOf("rev-parse --is-bare-repository");
  const measured = source.indexOf('size_verdict="$(repository_size_verdict)"');
  const cloned = source.indexOf("git clone");

  expect(existingCheck).toBeGreaterThanOrEqual(0);
  expect(measured).toBeGreaterThan(existingCheck);
  expect(cloned).toBeGreaterThan(measured);
  expect(source.slice(measured, cloned)).toContain(`exit ${PROJECT_CLONE_SIZE_FAILURE_EXIT_CODE}`);
});

test("the size check asks gh for the repository's API path and carries no credential", () => {
  const repository = parsePublicRepositoryUrl("https://github.com/Owner/a.b");

  if (repository === undefined) throw new Error("the sample URL must parse");

  const source = repositorySizeVerdictSource(repository);

  expect(source).toContain("api 'repos/Owner/a.b' --jq");
  expect(source).toContain("'repos/Owner/a.b/git/trees/'\"$branch\"'?recursive=1'");
  expect(source).not.toMatch(/GH_TOKEN|authorization|auth token/iu);
});
