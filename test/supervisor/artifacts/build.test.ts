import { afterEach, expect, test, vi } from "vitest";
import * as Result from "effect/Result";
import { resultOf } from "../../effect-result.js";
import { everythingLogged, textLines } from "../../log-capture.js";
import { syntheticJwt } from "../../synthetic-jwt.js";
import { testHarnessCommit } from "../../harness-commit-fixtures.js";
import { HARNESS_BUILD_STEP_NAMES } from "../../../src/harness-build.js";
import type { HarnessBuildRequest, HarnessBuildStepName } from "../../../src/harness-build.js";
import { buildModuleMap, encodeModuleMap } from "../../../src/supervisor/artifacts/index.js";
import type { BuildWorkspaceHost } from "../../../src/supervisor/artifacts/index.js";
import type { CommandOutput, WorkspaceResult } from "../../../src/workspace/index.js";
import { parsedArtifact } from "../../facet/fixture.js";

const commit = testHarnessCommit("6000000000000000000000000000000000000001");

const entryModule = { name: "main.js", source: "export default { fetch() {} };\n" };

const helperModule = { name: "helper.js", source: "export const help = 1;\n" };

const FAKE_TOKEN = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";

function moduleMapFile(modules: readonly Readonly<{ name: string; source: string }>[]): string {
  return JSON.stringify({ entryModule: "main.js", modules });
}

function answered(output: CommandOutput): Promise<WorkspaceResult> {
  return Promise.resolve({ ok: true, result: { kind: "command", ...output } });
}

class FakeBuildHost implements BuildWorkspaceHost {
  readonly requests: HarnessBuildRequest[] = [];
  output: string | undefined = moduleMapFile([helperModule, entryModule]);
  answers: Partial<Record<HarnessBuildStepName, CommandOutput>> = {};

  build(request: HarnessBuildRequest): Promise<WorkspaceResult> {
    this.requests.push(request);

    if (request.kind === "build-output") {
      return answered(
        this.output === undefined
          ? { stdout: "", stderr: "", exitCode: 1 }
          : { stdout: this.output, stderr: "", exitCode: 0 },
      );
    }

    return answered(this.answers[request.step] ?? { stdout: "", stderr: "", exitCode: 0 });
  }

  steps(): readonly string[] {
    return this.requests.map((request) =>
      request.kind === "build-step" ? request.step : request.kind,
    );
  }
}

function failingAt(step: HarnessBuildStepName, output: Partial<CommandOutput>): FakeBuildHost {
  const host = new FakeBuildHost();
  host.answers = { [step]: { stdout: "", stderr: "", exitCode: 7, ...output } };

  return host;
}

function built(host: BuildWorkspaceHost) {
  return resultOf(buildModuleMap(() => host, commit));
}

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

test("runs every step by name, reads the output, and parses it under the requested commit", async () => {
  const host = new FakeBuildHost();

  const result = await built(host);

  if (Result.isFailure(result)) {
    throw new Error(`a successful build must produce a module map: ${result.failure.code}`);
  }

  expect(encodeModuleMap(result.success)).toBe(
    encodeModuleMap(
      parsedArtifact({
        harnessCommit: commit,
        entryModule: "main.js",
        modules: [entryModule, helperModule],
      }),
    ),
  );
  expect(host.requests).toEqual([
    { kind: "build-step", harnessCommit: commit, step: "provision" },
    { kind: "build-step", harnessCommit: commit, step: "isolate" },
    { kind: "build-step", harnessCommit: commit, step: "checkout" },
    { kind: "build-step", harnessCommit: commit, step: "install" },
    { kind: "build-step", harnessCommit: commit, step: "build-module-map" },
    { kind: "build-output", harnessCommit: commit },
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
    }, commit),
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
      harnessCommit: commit,
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
    harnessCommit: commit,
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
    { code: "build-output-missing", harnessCommit: commit },
    { code: "build-output-invalid", harnessCommit: commit, reason: "invalid-artifact" },
    { code: "build-output-invalid", harnessCommit: commit, reason: "entry-module-not-found" },
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

  expect(result.success.harnessCommit).toBe(commit);
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
    { code: "build-workspace-unavailable", harnessCommit: commit },
    { code: "build-workspace-unavailable", harnessCommit: commit },
  ]);
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
  ).toContain(`harness-build.output ${commit}: build-output-missing: no file`);

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

test("the tail keeps the end of a long stream and says it was cut", async () => {
  const diagnostics = await failedDiagnostics({ stderr: `${"x".repeat(5_000)}THE END` });

  expect(diagnostics.stderrTail).toHaveLength(2_000);
  expect(diagnostics.stderrTail.endsWith("THE END")).toBe(true);
  expect(diagnostics.truncated).toBe(true);
});

test("a token that straddles the cut is redacted before the cut, so no fragment survives", async () => {
  const stderr = `${FAKE_TOKEN} ${"y".repeat(1_979)}`;

  const { stderrTail } = await failedDiagnostics({ stderr });

  for (let length = 8; length <= FAKE_TOKEN.length; length += 1) {
    expect(stderrTail, `${length} characters of the token`).not.toContain(
      FAKE_TOKEN.slice(0, length),
    );
    expect(stderrTail, `the last ${length} characters of the token`).not.toContain(
      FAKE_TOKEN.slice(-length),
    );
  }

  expect(stderrTail.endsWith("y")).toBe(true);
});

test("a JWT in the output is redacted from the owner's tail too", async () => {
  const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.c2lnbmF0dXJl";

  const { stdoutTail, stderrTail } = await failedDiagnostics({
    stdout: `token ${jwt}`,
    stderr: `denied for ${jwt}`,
  });

  expect(stdoutTail).not.toContain("eyJ");
  expect(stderrTail).not.toContain("eyJ");
  expect(stderrTail).toContain("denied for");
});

test("the cut never leaves half of a surrogate pair", async () => {
  const { stderrTail } = await failedDiagnostics({ stderr: `${"😀".repeat(1_000)}x` });

  expect(stderrTail.codePointAt(0)).toBe(0x1f600);
  expect(stderrTail.endsWith("😀x")).toBe(true);
});
