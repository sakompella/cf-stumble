import { expect, test } from "vitest";
import {
  credentialStatusSource,
  installCredentialSource,
  repositoryAccessSource,
} from "../../src/github/index.js";
import {
  HARNESS_BUILD_CONFIGURATION,
  provisionHarnessRepository,
} from "../../src/harness-build.js";
import {
  planProjectProvision,
  projectProvisionConfiguration,
  projectProvisionStep,
} from "../../src/project-provision.js";
import { testHarnessCommit } from "../harness-commit-fixtures.js";
import { sampleProjectOne } from "../project-fixtures.js";
import { GITHUB_CLI_CONFIG_DIRECTORY, GIT_GLOBAL_CONFIG_PATH } from "../../src/workspace-layout.js";

/**
 * Computer persists only the workspace, so every command that needs the GitHub credential names
 * the durable `gh` and Git configuration itself instead of trusting the image's environment.
 */

const exportsDurableConfiguration = [
  `export GH_CONFIG_DIR='${GITHUB_CLI_CONFIG_DIRECTORY}'`,
  `export GIT_CONFIG_GLOBAL='${GIT_GLOBAL_CONFIG_PATH}'`,
];

test.each([
  ["install", installCredentialSource()],
  ["status", credentialStatusSource()],
  ["repository access", repositoryAccessSource("https://github.com/owner/repo")],
])("the %s command exports the durable gh and Git configuration first", (_name, source) => {
  const lines = source.split("\n");
  const firstUse = lines.findIndex((line) => /\b(gh|git) (auth|api|ls-remote)\b/u.test(line));

  for (const exported of exportsDurableConfiguration) {
    const at = lines.indexOf(exported);

    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(firstUse);
  }
});

test("the install command still takes the token from standard input only", () => {
  expect(installCredentialSource()).toContain("gh auth login --hostname github.com --with-token");
  expect(installCredentialSource()).not.toMatch(/ghp_|github_pat_/u);
});

test("clone and harness provisioning export the durable configuration for private repositories", () => {
  const plan = planProjectProvision(
    projectProvisionConfiguration(sampleProjectOne.id),
    sampleProjectOne,
  );

  const step = projectProvisionStep(plan, "clone");
  const clone = step.name === "clone" ? step.source : "";

  const harness = provisionHarnessRepository(
    HARNESS_BUILD_CONFIGURATION,
    testHarnessCommit("5000000000000000000000000000000000000001"),
  );

  for (const source of [clone, harness]) {
    for (const exported of exportsDurableConfiguration) {
      expect(source).toContain(exported);
    }
  }
});
