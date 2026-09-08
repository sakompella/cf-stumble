import { expect, test } from "vitest";
import {
  executeHarnessBuildRequest,
  WorkspaceHost,
  type CommandOutput,
  type WorkspaceOperations,
  type WorkspacePathKind,
} from "../../src/workspace/index.js";
import { HARNESS_BUILD_CONFIGURATION } from "../../src/harness-build.js";
import { workspaceContainerBackendConfiguration } from "../../src/workspace/host.js";

/**
 * What the Workspace Host offers as a Durable Object, rather than what any one of its surfaces
 * decides. The build, provisioning, and credential surfaces are each checked in their own file;
 * what is held here is that the object exposes those surfaces and nothing else, and that what a
 * surface returns can cross an RPC boundary.
 */

const commit = "5000000000000000000000000000000000000001";

/** Enough of the operation port to answer one planned build read. */
class FakeOperations implements WorkspaceOperations {
  lstat(): Promise<WorkspacePathKind | undefined> {
    return Promise.resolve("directory");
  }

  readFile(): Promise<string> {
    return Promise.resolve("{}");
  }

  writeFile(): Promise<void> {
    return Promise.reject(new Error("this test writes nothing"));
  }

  runCommand(): Promise<CommandOutput> {
    return Promise.resolve({ stdout: "{}", stderr: "", exitCode: 0 });
  }
}

test("configures the container backend for direct egress", () => {
  expect(workspaceContainerBackendConfiguration("workspace-id").egress).toEqual({ mode: "direct" });
});

test("returns plain cloneable values and exposes no raw Computer RPC method", async () => {
  const result = await executeHarnessBuildRequest({
    configuration: HARNESS_BUILD_CONFIGURATION,
    operations: new FakeOperations(),
    request: { kind: "build-output", harnessCommit: commit },
  });

  expect(result).toEqual({
    ok: true,
    result: { kind: "command", stdout: "{}", stderr: "", exitCode: 0 },
  });
  expect(structuredClone(result)).toEqual(result);
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect(
    Object.getOwnPropertyNames(WorkspaceHost.prototype).toSorted(),
    "`project` hands out the narrow project capability; anything else added here is a new surface",
  ).toEqual(["build", "constructor", "credential", "fetch", "project", "provision"]);
});
