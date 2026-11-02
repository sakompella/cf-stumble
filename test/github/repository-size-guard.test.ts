import { expect, test } from "vitest";
import { repositorySizeVerdictSource } from "../../src/github/repository-size-guard.js";
import { parsePublicRepositoryUrl } from "../../src/project-catalog.js";

test("the size check asks gh for the repository's API path and carries no credential", () => {
  const repository = parsePublicRepositoryUrl("https://github.com/Owner/a.b");

  if (repository === undefined) throw new Error("the sample URL must parse");

  const source = repositorySizeVerdictSource(repository);

  expect(source).toContain("api 'repos/Owner/a.b' --jq");
  expect(source).toContain("'repos/Owner/a.b/git/trees/'\"$branch\"'?recursive=1'");
  expect(source).not.toMatch(/GH_TOKEN|authorization|auth token/iu);
});
