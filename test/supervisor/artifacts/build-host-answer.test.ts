import { expect, test } from "vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { resultOf } from "../../effect-result.js";
import { HARNESS_BUILD_CONFIGURATION } from "../../../src/harness-build.js";
import { buildModuleMap } from "../../../src/supervisor/artifacts/build.js";
import {
  executeHarnessBuildDiscard,
  executeHarnessBuildOutput,
  executeHarnessBuildStep,
} from "../../../src/workspace/commands/build-harness.js";
import type { BuildWorkspace } from "../../../src/supervisor/artifacts/build.js";
import { harnessBuildOutputPath } from "../../../src/workspace-layout.js";
import { workspaceEffects, type PromiseOperations } from "../../workspace/promise-operations.js";
import { BUILD_COMMIT, entryModule, moduleMapFile } from "./scripted-build-host.js";

const CODE_UPDATE_RESET = "Durable Object reset because its code was updated.";

class ResettableOperations implements PromiseOperations {
  provisions = 0;
  failure: Error | undefined;
  failures = 0;

  provisionHarness() {
    this.provisions += 1;

    if (this.failure !== undefined && this.provisions <= this.failures) {
      return Promise.reject(this.failure);
    }

    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  lstat() {
    return Promise.resolve("directory" as const);
  }

  readFile(path: string) {
    return path === harnessBuildOutputPath(BUILD_COMMIT)
      ? Promise.resolve(moduleMapFile([entryModule]))
      : Promise.reject(new Error("missing file"));
  }

  writeFile() {
    return Promise.reject(new Error("a build never writes through the workspace surface"));
  }

  runCommand() {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

function hostOver(operations: ResettableOperations): BuildWorkspace {
  const input = {
    configuration: HARNESS_BUILD_CONFIGURATION,
    operations: workspaceEffects(operations),
  };

  return {
    build: (request) => Effect.runPromise(executeHarnessBuildStep({ ...input, request })),
    buildOutput: (request) => Effect.runPromise(executeHarnessBuildOutput({ ...input, request })),
    discardBuild: (request) => Effect.runPromise(executeHarnessBuildDiscard({ ...input, request })),
  };
}

function afterFailing(failure: Error, times: number): ResettableOperations {
  const operations = new ResettableOperations();
  operations.failure = failure;
  operations.failures = times;

  return operations;
}

test("a build starts again once when the platform resets what the Workspace Host called and the Host answers it (deploy 44114195991)", async () => {
  const operations = afterFailing(new Error(CODE_UPDATE_RESET), 1);

  const result = await resultOf(buildModuleMap(() => hostOver(operations), BUILD_COMMIT));

  expect(Result.isSuccess(result) ? "built" : result.failure.code).toBe("built");
  expect(operations.provisions).toBe(2);
});

test("a build that is reset under the Host twice is unavailable after two tries", async () => {
  const operations = afterFailing(new Error(CODE_UPDATE_RESET), 2);

  const result = await resultOf(buildModuleMap(() => hostOver(operations), BUILD_COMMIT));

  expect(Result.isFailure(result) ? result.failure.code : "built").toBe(
    "build-workspace-unavailable",
  );
  expect(operations.provisions).toBe(2);
});

test("a build whose workspace is really unavailable fails after one try", async () => {
  const operations = afterFailing(new Error("container exited before the command could run"), 2);

  const result = await resultOf(buildModuleMap(() => hostOver(operations), BUILD_COMMIT));

  expect(Result.isFailure(result) ? result.failure.code : "built").toBe(
    "build-workspace-unavailable",
  );
  expect(operations.provisions).toBe(1);
});
