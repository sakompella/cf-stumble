import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { HARNESS_BUILD_CONFIGURATION } from "../../src/harness-build.js";
import { provisionHarness } from "../../src/workspace/harness-provision.js";
import type { CommandOutput } from "../../src/workspace/operations.js";
import { testHarnessCommit } from "../harness-commit-fixtures.js";

const COMMIT = testHarnessCommit("a".repeat(40));

function container(output: CommandOutput) {
  const scripts: string[] = [];

  const run = (source: string) => {
    scripts.push(source);

    return Effect.succeed(output);
  };

  return { scripts, run };
}

function provision(output: CommandOutput) {
  const { scripts, run } = container(output);

  return {
    scripts,
    answer: Effect.runPromise(provisionHarness(run, HARNESS_BUILD_CONFIGURATION, COMMIT)),
  };
}

const ok = { stdout: "", stderr: "", exitCode: 0 };

test("provisions the harness checkout with one container script and no Host-side Git", async () => {
  const { scripts, answer } = provision(ok);

  await expect(answer).resolves.toEqual(ok);
  expect(scripts).toHaveLength(1);
});

test("a failing container script fails the provision with its exit code and message", async () => {
  const { answer } = provision({ stdout: "", stderr: "fatal: not a repository\n", exitCode: 128 });

  await expect(answer).resolves.toEqual({
    stdout: "",
    stderr: "fatal: not a repository\n",
    exitCode: 128,
  });
});

test("reports what the container's advance of the checkout says", async () => {
  const message = `harness checkout has local changes; left at ${COMMIT.slice(0, 7)}\n`;

  await expect(provision({ stdout: "", stderr: message, exitCode: 0 }).answer).resolves.toEqual({
    stdout: "",
    stderr: message,
    exitCode: 0,
  });
});
