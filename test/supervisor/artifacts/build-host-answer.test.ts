import { expect, test } from "vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { HARNESS_BUILD_CONFIGURATION } from "../../../src/harness-build.js";
import {
  executeHarnessBuildDiscard,
  executeHarnessBuildOutput,
  executeHarnessBuildStep,
} from "../../../src/workspace/commands/build-harness.js";
import type { BuildWorkspace } from "../../../src/supervisor/artifacts/build.js";
import { harnessBuildOutputPath } from "../../../src/workspace-layout.js";
import { workspaceEffects, type PromiseOperations } from "../../workspace/promise-operations.js";
import { CODE_UPDATE_RESET } from "../../platform-reset.js";
import { BUILD_COMMIT, built, entryModule, moduleMapFile } from "./scripted-build-host.js";

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

test("a build whose Host answers the platform reset is unavailable after one try, so the caller owns the repeat (deploy 44114195991)", async () => {
  const operations = afterFailing(CODE_UPDATE_RESET, 2);

  const result = await built(hostOver(operations));

  expect(Result.isFailure(result) ? result.failure.code : "built").toBe(
    "build-workspace-unavailable",
  );
  expect(operations.provisions).toBe(1);
});

test("a build whose workspace is really unavailable fails after one try", async () => {
  const operations = afterFailing(new Error("container exited before the command could run"), 2);

  const result = await built(hostOver(operations));

  expect(Result.isFailure(result) ? result.failure.code : "built").toBe(
    "build-workspace-unavailable",
  );
  expect(operations.provisions).toBe(1);
});
