import { afterEach, expect, test, vi } from "vitest";
import * as Result from "effect/Result";
import type { CommandOutput } from "../../../src/workspace/index.js";
import { everythingLogged } from "../../log-capture.js";
import { built, failingAt } from "./scripted-build-host.js";

const FAKE_TOKEN = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";

async function failedDiagnostics(output: Partial<CommandOutput>) {
  const result = await built(failingAt("provision", output));

  if (Result.isSuccess(result) || result.failure.code !== "build-step-failed") {
    throw new Error("the step must fail with a build-step-failed problem");
  }

  return result.failure.diagnostics;
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("a failed step gives the owner its output tail with every credential redacted, and logs none of it", async () => {
  const diagnostics = await failedDiagnostics({
    stdout: `fetching https://x-access-token:${FAKE_TOKEN}@github.com/o/r`,
    stderr: `fatal: authentication failed for ${FAKE_TOKEN}`,
  });

  expect(diagnostics.stderrTail, "the owner can read why the build failed").toContain(
    "authentication failed",
  );
  expect(JSON.stringify(diagnostics), "a credential never reaches even the owner").not.toContain(
    FAKE_TOKEN,
  );
  expect(diagnostics.truncated).toBe(false);

  const logged = everythingLogged();
  expect(logged, "command output is not written to a log").not.toContain("authentication failed");
  expect(logged).not.toContain("x-access-token");
  expect(logged).not.toContain(FAKE_TOKEN);
});
