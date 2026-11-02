import { expect, test } from "vitest";
import {
  HARNESS_BUILD_CONFIGURATION,
  provisionHarnessRepository,
} from "../../src/harness-build.js";
import { projectCloneSource } from "../../src/project-provision.js";
import { testHarnessCommit } from "../harness-commit-fixtures.js";
import { sampleProjectOne } from "../project-fixtures.js";
import { GITHUB_CLI_CONFIG_DIRECTORY, GIT_GLOBAL_CONFIG_PATH } from "../../src/workspace-layout.js";

const exportsDurableConfiguration = [
  `export GH_CONFIG_DIR='${GITHUB_CLI_CONFIG_DIRECTORY}'`,
  `export GIT_CONFIG_GLOBAL='${GIT_GLOBAL_CONFIG_PATH}'`,
];

test.each([
  ["project clone", projectCloneSource(sampleProjectOne)],
  [
    "harness provisioning",
    provisionHarnessRepository(
      HARNESS_BUILD_CONFIGURATION,
      testHarnessCommit("5000000000000000000000000000000000000001"),
    ),
  ],
])("the %s command exports the durable gh and Git configuration first", (_name, source) => {
  const lines = source.split("\n");

  const firstOther = lines.findIndex(
    (line) => !line.startsWith("set ") && !exportsDurableConfiguration.includes(line),
  );

  for (const exported of exportsDurableConfiguration) {
    const at = lines.indexOf(exported);

    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(firstOther);
  }
});
