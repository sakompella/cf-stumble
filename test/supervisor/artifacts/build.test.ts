import { afterEach, expect, test, vi } from "vitest";
import * as Result from "effect/Result";
import { resultOf } from "../../effect-result.js";
import type { HarnessBuildStepName } from "../../../src/harness-build.js";
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
  FakeBuildHost,
  helperModule,
} from "./scripted-build-host.js";

afterEach(() => {
  vi.useRealTimers();
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

function resetAt(step: HarnessBuildStepName, times: number): FakeBuildHost {
  const host = new FakeBuildHost();
  const build = host.build.bind(host);
  let resets = 0;

  host.build = (request) => {
    if (request.step !== step || resets >= times) return build(request);

    resets += 1;
    host.requests.push(request.step);

    return Promise.reject(CODE_UPDATE_RESET);
  };

  return host;
}

test("a build starts again once when a deploy resets the Workspace Host under it (3b5a74a5, deploy 43934982845)", async () => {
  for (const step of ["provision", "install"] as const) {
    const host = resetAt(step, 1);

    const result = await built(host);

    expect(Result.isSuccess(result) ? "built" : result.failure.code, step).toBe("built");
    expect(
      host.steps().filter((request) => request === "provision"),
      step,
    ).toHaveLength(2);
    expect(
      host.steps().filter((request) => request === "build-discard"),
      step,
    ).toHaveLength(2);
  }
});

test("a build that the deploy resets twice is unavailable, not retried again", async () => {
  const host = resetAt("provision", 2);

  const result = await built(host);

  expect(Result.isFailure(result) ? result.failure : "built").toEqual({
    code: "build-workspace-unavailable",
    harnessCommit: BUILD_COMMIT,
  });
  expect(host.steps().filter((request) => request === "provision")).toHaveLength(2);
});

test("a Workspace Host error that is not a code update is not retried", async () => {
  const host = new FakeBuildHost();
  host.build = (request) => {
    host.requests.push(request.step);

    return Promise.reject(new Error("the container is not running"));
  };

  const result = await built(host);

  expect(Result.isFailure(result) ? result.failure.code : "built").toBe(
    "build-workspace-unavailable",
  );
  expect(host.steps().filter((request) => request === "provision")).toHaveLength(1);
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
});
