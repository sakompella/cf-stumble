import { afterEach, expect, test, vi } from "vitest";
import * as Result from "effect/Result";
import type { CommandOutput } from "../../../src/workspace/index.js";
import { everythingLogged, textLines } from "../../log-capture.js";
import { syntheticJwt } from "../../synthetic-jwt.js";
import { BUILD_COMMIT, built, FakeBuildHost, failingAt } from "./scripted-build-host.js";

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

test("an unavailable build workspace logs its cause with every credential redacted", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  const jwt = syntheticJwt();

  const result = await built({
    build: () =>
      Promise.reject(new Error(`container refused ${jwt.token} for x:${FAKE_TOKEN}@github.com`)),
  });

  expect(Result.isFailure(result) ? result.failure.code : "ok").toBe("build-workspace-unavailable");
  expect(textLines(errors).join("\n"), "the cause still explains the failure").toMatch(
    /harness-build\.provision: build-workspace-unavailable: container refused \[redacted\]/u,
  );

  const logged = everythingLogged();

  for (const segment of jwt.segments) expect(logged).not.toContain(segment);
  expect(logged).not.toContain(FAKE_TOKEN);
});

test("missing build output logs its cause with every credential redacted", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  const jwt = syntheticJwt();
  const host = new FakeBuildHost();

  const result = await built({
    build: (request) =>
      request.kind === "build-output"
        ? Promise.reject(new Error(`no file; request carried ${jwt.token} ${FAKE_TOKEN}`))
        : host.build(request),
  });

  expect(Result.isFailure(result) ? result.failure.code : "ok").toBe("build-output-missing");
  expect(
    textLines(errors).join("\n"),
    "the log names the commit whose output is missing",
  ).toContain(`harness-build.output ${BUILD_COMMIT}: build-output-missing: no file`);

  const logged = everythingLogged();

  for (const segment of jwt.segments) expect(logged).not.toContain(segment);
  expect(logged).not.toContain(FAKE_TOKEN);
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
