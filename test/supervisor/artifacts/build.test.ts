import { afterEach, expect, test, vi } from "vitest";
import * as Result from "effect/Result";
import { resultOf } from "../../effect-result.js";
import { textLines } from "../../log-capture.js";
import { WORKSPACE_RPC_TIMEOUT_MS } from "../../../src/workspace-command-timeout.js";
import { buildModuleMap } from "../../../src/supervisor/artifacts/build.js";
import { encodeModuleMap } from "../../../src/supervisor/artifacts/module-map.js";
import { CODE_UPDATE_RESET } from "../../platform-reset.js";
import { parsedArtifact } from "../../facet/fixture.js";
import {
  BUILD_COMMIT,
  built,
  type BuildWorkspaceFake,
  entryModule,
  failureLines,
  FakeBuildHost,
  helperModule,
} from "./scripted-build-host.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("a build returns the module map the workspace wrote, under the requested commit, and sends no command line", async () => {
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
  expect(
    host.requests.every((request) => !JSON.stringify(request).includes("git ")),
    "a build request carries a commit and a step name, never a command",
  ).toBe(true);
});

function oneCallStub(): BuildWorkspaceFake {
  const host = new FakeBuildHost();

  const once = <A>(call: () => Promise<A>): Promise<A> =>
    host.requests.length === 0
      ? call()
      : Promise.reject(new Error("this Durable Object instance is no longer active"));

  return {
    build: (request) => once(() => host.build(request)),
    buildOutput: () => once(() => host.buildOutput()),
    discardBuild: () => once(() => host.discardBuild()),
  };
}

test("a build survives a Workspace Host restart that kills the stub of an earlier call (33d042e1)", async () => {
  const result = await resultOf(buildModuleMap(oneCallStub, BUILD_COMMIT));

  expect(Result.isSuccess(result) ? "built" : result.failure.code).toBe("built");
});

const STORAGE_STARTUP = new Error(
  "Internal error while starting up Durable Object storage caused object to be reset; reference = b8sd9000hraaunrso5ttv63p",
);

function rejectingAt(step: "provision" | "build-output", failure: Error): FakeBuildHost {
  const host = new FakeBuildHost();
  const build = host.build.bind(host);

  host.build = (request) => {
    if (step !== request.step) return build(request);

    host.requests.push(request.step);

    return Promise.reject(failure);
  };

  host.buildOutput = () => {
    host.requests.push("build-output");

    return Promise.reject(failure);
  };

  return host;
}

test("a build that the platform interrupts is unavailable after one try, whatever mark the error carries (deploy 44185631101), and discards the scratch tree", async () => {
  for (const failure of [STORAGE_STARTUP, CODE_UPDATE_RESET]) {
    const host = rejectingAt("provision", failure);

    const result = await built(host);

    expect(Result.isFailure(result) ? result.failure : "built").toEqual({
      code: "build-workspace-unavailable",
      harnessCommit: BUILD_COMMIT,
    });
    expect(host.steps()).toEqual(["provision", "build-discard"]);
  }
});

test("a module map read that the platform interrupts is unavailable, not a missing output", async () => {
  const host = rejectingAt("build-output", STORAGE_STARTUP);

  const result = await built(host);

  expect(Result.isFailure(result) ? result.failure.code : "built").toBe(
    "build-workspace-unavailable",
  );
});

test("a module map the build did not publish is a missing output, not an interruption", async () => {
  const host = new FakeBuildHost();
  host.output = undefined;

  const result = await built(host);

  expect(Result.isFailure(result) ? result.failure.code : "built").toBe("build-output-missing");
});

test("logs the platform's retryable and overloaded flags of an interrupted call once, and 'absent' when it sets none", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});

  await built(rejectingAt("provision", STORAGE_STARTUP));
  await built(rejectingAt("provision", CODE_UPDATE_RESET));

  expect(textLines(errors).filter((line) => line.startsWith("harness-build."))).toEqual([
    `harness-build.provision: build-workspace-unavailable: ${STORAGE_STARTUP.message} [retryable=absent overloaded=absent]`,
    `harness-build.provision: build-workspace-unavailable: ${CODE_UPDATE_RESET.message} [retryable=true overloaded=absent]`,
  ]);
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

test("a step the workspace never answers fails as unavailable at the RPC deadline and still discards the scratch tree", async () => {
  vi.useFakeTimers();
  const logged = failureLines();
  const host = new FakeBuildHost();
  const build = host.build.bind(host);

  host.build = (request) =>
    request.step === "install" ? build(request).then(() => new Promise(() => {})) : build(request);

  const building = built(host);
  await vi.advanceTimersByTimeAsync(WORKSPACE_RPC_TIMEOUT_MS);
  const result = await building;

  expect(Result.isFailure(result) ? result.failure : "built").toEqual({
    code: "build-workspace-unavailable",
    harnessCommit: BUILD_COMMIT,
  });
  expect(host.steps().slice(-2)).toEqual(["install", "build-discard"]);
  expect(logged()).toEqual(["harness-build.install: timeout"]);
});

test("a step the workspace rejects with a message that says it timed out logs unavailable, not timeout", async () => {
  const logged = failureLines();
  const host = new FakeBuildHost();

  host.build = (request) => {
    host.requests.push(request.step);

    return Promise.reject(new Error("git clone timed out"));
  };

  const result = await built(host);

  expect(Result.isFailure(result) ? result.failure.code : "built").toBe(
    "build-workspace-unavailable",
  );
  expect(logged()).toEqual(["harness-build.provision: build-workspace-unavailable"]);
});
