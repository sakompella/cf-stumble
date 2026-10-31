import { afterEach, expect, test, vi } from "vitest";
import * as Result from "effect/Result";
import { resultOf } from "../../effect-result.js";
import { HARNESS_BUILD_STEP_NAMES } from "../../../src/harness-build.js";
import { buildModuleMap } from "../../../src/supervisor/artifacts/build.js";
import { encodeModuleMap } from "../../../src/supervisor/artifacts/module-map.js";
import type { BuildWorkspaceHost } from "../../../src/supervisor/artifacts/index.js";
import { parsedArtifact } from "../../facet/fixture.js";
import {
  BUILD_COMMIT,
  built,
  entryModule,
  FakeBuildHost,
  failingAt,
  helperModule,
  moduleMapFile,
} from "./scripted-build-host.js";

afterEach(() => {
  vi.restoreAllMocks();
});

test("runs every step by name, reads the output, and parses it under the requested commit", async () => {
  const host = new FakeBuildHost();

  const result = await built(host);

  if (Result.isFailure(result)) {
    throw new Error(`a successful build must produce a module map: ${result.failure.code}`);
  }

  expect(encodeModuleMap(result.success)).toBe(
    encodeModuleMap(
      parsedArtifact({
        harnessCommit: BUILD_COMMIT,
        entryModule: "main.js",
        modules: [entryModule, helperModule],
      }),
    ),
  );
  expect(host.requests).toEqual([
    { kind: "build-step", harnessCommit: BUILD_COMMIT, step: "provision" },
    { kind: "build-step", harnessCommit: BUILD_COMMIT, step: "isolate" },
    { kind: "build-step", harnessCommit: BUILD_COMMIT, step: "checkout" },
    { kind: "build-step", harnessCommit: BUILD_COMMIT, step: "install" },
    { kind: "build-step", harnessCommit: BUILD_COMMIT, step: "build-module-map" },
    { kind: "build-output", harnessCommit: BUILD_COMMIT },
  ]);
  expect(
    host.requests.every((request) => !JSON.stringify(request).includes("git ")),
    "a build request carries a commit and a step name, never a command",
  ).toBe(true);
});

test("takes a fresh workspace stub for every call in one build", async () => {
  const hosts: FakeBuildHost[] = [];

  const result = await resultOf(
    buildModuleMap(() => {
      const host = new FakeBuildHost();
      hosts.push(host);

      return host;
    }, BUILD_COMMIT),
  );

  expect(Result.isSuccess(result), "the build reads its own output").toBe(true);
  expect(
    hosts.length,
    "a build that held one stub died with the Workspace Host it was taken from, minutes earlier",
  ).toBe(HARNESS_BUILD_STEP_NAMES.length + 1);
  expect(hosts.every((host) => host.requests.length === 1)).toBe(true);
});

test("a failing step names that step, and the steps after it never run", async () => {
  for (const failing of HARNESS_BUILD_STEP_NAMES) {
    const host = failingAt(failing, { stderr: `${failing} failed` });

    const result = await built(host);

    expect(Result.isFailure(result) ? result.failure : "built").toEqual({
      code: "build-step-failed",
      harnessCommit: BUILD_COMMIT,
      step: failing,
      exitCode: 7,
      diagnostics: { stdoutTail: "", stderrTail: `${failing} failed`, truncated: false },
    });
    expect(host.steps(), "a build stops at the step that failed").toEqual(
      HARNESS_BUILD_STEP_NAMES.slice(0, HARNESS_BUILD_STEP_NAMES.indexOf(failing) + 1),
    );
  }
});

test("retries provisioning after an interrupted checkout", async () => {
  const host = failingAt("checkout", { stderr: "build failed", exitCode: 3 });

  const interrupted = await built(host);
  host.answers = {};
  const resumed = await built(host);

  if (Result.isSuccess(interrupted) || Result.isFailure(resumed)) {
    throw new Error("the checkout interruption must recover on the next build request");
  }

  expect(interrupted.failure).toEqual({
    code: "build-step-failed",
    harnessCommit: BUILD_COMMIT,
    step: "checkout",
    exitCode: 3,
    diagnostics: { stdoutTail: "", stderrTail: "build failed", truncated: false },
  });
  expect(host.steps().filter((step) => step === "provision")).toHaveLength(2);
});

test("reports missing and invalid build output as plain typed failures", async () => {
  const missing = new FakeBuildHost();
  missing.output = undefined;
  const invalid = new FakeBuildHost();
  invalid.output = "{";
  const withoutEntry = new FakeBuildHost();
  withoutEntry.output = moduleMapFile([helperModule]);

  const results = [await built(missing), await built(invalid), await built(withoutEntry)];

  expect(results.map((result) => (Result.isFailure(result) ? result.failure : "ok"))).toEqual([
    { code: "build-output-missing", harnessCommit: BUILD_COMMIT },
    { code: "build-output-invalid", harnessCommit: BUILD_COMMIT, reason: "invalid-artifact" },
    { code: "build-output-invalid", harnessCommit: BUILD_COMMIT, reason: "entry-module-not-found" },
  ]);
  expect(
    results.every(
      (result) =>
        Result.isFailure(result) && Object.getPrototypeOf(result.failure) === Object.prototype,
    ),
    "a build failure stays a plain value the Supervisor can return",
  ).toBe(true);
});

test("gives the built module map the commit the Supervisor asked to build", async () => {
  const host = new FakeBuildHost();
  host.output = JSON.stringify({
    harnessCommit: "3000000000000000000000000000000000000009",
    entryModule: "main.js",
    modules: [entryModule],
  });

  const result = await built(host);

  if (Result.isFailure(result)) {
    throw new Error("a valid build output must produce a module map");
  }

  expect(result.success.harnessCommit).toBe(BUILD_COMMIT);
});

test("a refused or unreachable build workspace stays a typed failure", async () => {
  const refused: BuildWorkspaceHost = {
    build: () => Promise.resolve({ ok: false, error: { code: "unknown-command" } }),
  };

  const gone: BuildWorkspaceHost = {
    build: () => Promise.reject(new Error("the build workspace is gone")),
  };

  vi.spyOn(console, "error").mockImplementation(() => {});

  const results = [await built(refused), await built(gone)];

  expect(results.map((result) => (Result.isFailure(result) ? result.failure : "ok"))).toEqual([
    { code: "build-workspace-unavailable", harnessCommit: BUILD_COMMIT },
    { code: "build-workspace-unavailable", harnessCommit: BUILD_COMMIT },
  ]);
});
