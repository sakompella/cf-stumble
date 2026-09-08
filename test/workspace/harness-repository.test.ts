import { expect, test } from "vitest";
import { harnessBuildConfiguration, HARNESS_BUILD_CONFIGURATION } from "../../src/harness-build.js";

/**
 * A fork has one setting to change. Everything else about a build comes from the workspace layout,
 * so this proves the variable reaches the remote and reaches nothing else.
 */
test("a deployment builds from the repository its variable names", () => {
  const forked = harnessBuildConfiguration("https://github.com/somebody/cf-stumble.git");

  expect(forked.harnessGitRemote).toBe("https://github.com/somebody/cf-stumble.git");
  expect(
    { ...forked, harnessGitRemote: HARNESS_BUILD_CONFIGURATION.harnessGitRemote },
    "the variable moves the remote and nothing else",
  ).toEqual(HARNESS_BUILD_CONFIGURATION);
});

test("an unset or blank variable builds from this repository", () => {
  for (const value of [undefined, "", "   "]) {
    expect(harnessBuildConfiguration(value)).toEqual(HARNESS_BUILD_CONFIGURATION);
  }
});

test("a variable with surrounding space still names one remote", () => {
  expect(
    harnessBuildConfiguration("  https://github.com/somebody/fork.git \n").harnessGitRemote,
  ).toBe("https://github.com/somebody/fork.git");
});
