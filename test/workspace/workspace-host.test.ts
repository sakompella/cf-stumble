import { expect, test } from "vitest";
import {
  executeHarnessBuildRequest,
  type CommandOutput,
  type WorkspaceOperations,
  type WorkspacePathKind,
} from "../../src/workspace/executor.js";
import { HARNESS_BUILD_CONFIGURATION } from "../../src/harness-build.js";
import {
  ensureManagedInstructions,
  WorkspaceHost,
  workspaceContainerBackendConfiguration,
} from "../../src/workspace/host.js";

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
  ).toEqual([
    "build",
    "constructor",
    "credential",
    "ensureManagedInstructions",
    "fetch",
    "project",
    "provision",
    "reset",
  ]);
});

class ManagedInstructionsOperations implements WorkspaceOperations {
  existing: WorkspacePathKind | undefined;
  readonly writes: string[] = [];

  lstat(path: string): Promise<WorkspacePathKind | undefined> {
    return Promise.resolve(path === "/workspace/AGENTS.md" ? this.existing : "directory");
  }

  readFile(): Promise<string> {
    return Promise.resolve("");
  }

  writeFile(_path: string, content: string): Promise<void> {
    this.writes.push(content);

    return Promise.resolve();
  }

  runCommand(): Promise<CommandOutput> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

test("writes managed instructions only when the workspace reset removed them", async () => {
  const operations = new ManagedInstructionsOperations();

  await expect(ensureManagedInstructions(operations)).resolves.toMatchObject({
    ok: true,
    result: { kind: "written" },
  });
  expect(operations.writes).toHaveLength(1);

  operations.existing = "file";
  await expect(ensureManagedInstructions(operations)).resolves.toMatchObject({
    ok: true,
    result: { kind: "written" },
  });
  expect(operations.writes).toHaveLength(1);
});
