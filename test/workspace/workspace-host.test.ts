import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import {
  executeHarnessBuildRequest,
  type CommandOutput,
  type WorkspaceOperations,
  type WorkspacePathKind,
} from "../../src/workspace/executor.js";
import { HARNESS_BUILD_CONFIGURATION } from "../../src/harness-build.js";
import { MANAGED_AGENT_INSTRUCTIONS } from "../../src/project-provision.js";
import { MANAGED_AGENT_INSTRUCTIONS_PATH, WORKSPACE_ROOT } from "../../src/workspace-layout.js";
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

test("returns a build result as a plain value", async () => {
  const result = await Effect.runPromise(
    executeHarnessBuildRequest({
      configuration: HARNESS_BUILD_CONFIGURATION,
      operations: new FakeOperations(),
      request: { kind: "build-output", harnessCommit: commit },
    }),
  );

  expect(result).toEqual({
    ok: true,
    result: { kind: "command", stdout: "{}", stderr: "", exitCode: 0 },
  });
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
});

test("exposes only the Workspace Host RPC methods", () => {
  expect(
    Object.getOwnPropertyNames(WorkspaceHost.prototype).toSorted(),
    "`project` hands out the narrow project capability; anything else added here is a new surface",
  ).toEqual([
    "alarm",
    "build",
    "constructor",
    "credential",
    "ensureManagedInstructions",
    "fetch",
    "project",
    "provision",
    "removeProject",
    "reset",
  ]);
});

/** A workspace store that holds only the managed file's path, as the test arranges it. */
class ManagedInstructionsOperations implements WorkspaceOperations {
  readonly kinds = new Map<string, WorkspacePathKind>([[WORKSPACE_ROOT, "directory"]]);
  readonly files = new Map<string, string>();

  lstat(path: string): Promise<WorkspacePathKind | undefined> {
    return Promise.resolve(this.kinds.get(path));
  }

  readFile(): Promise<string> {
    return Promise.reject(new Error("the managed instructions writer reads nothing"));
  }

  writeFile(path: string, content: string): Promise<void> {
    this.kinds.set(path, "file");
    this.files.set(path, content);

    return Promise.resolve();
  }

  runCommand(): Promise<CommandOutput> {
    return Promise.reject(new Error("the managed instructions writer runs nothing"));
  }
}

test("writes the managed instructions when the workspace has none", async () => {
  const operations = new ManagedInstructionsOperations();

  await expect(Effect.runPromise(ensureManagedInstructions(operations))).resolves.toEqual({
    ok: true,
    result: { kind: "written" },
  });
  expect(operations.files.get(MANAGED_AGENT_INSTRUCTIONS_PATH)).toBe(MANAGED_AGENT_INSTRUCTIONS);
});

test("replaces a stale managed instructions file with the current text", async () => {
  const operations = new ManagedInstructionsOperations();
  operations.kinds.set(MANAGED_AGENT_INSTRUCTIONS_PATH, "file");
  operations.files.set(MANAGED_AGENT_INSTRUCTIONS_PATH, "# instructions from an older release\n");

  await expect(Effect.runPromise(ensureManagedInstructions(operations))).resolves.toEqual({
    ok: true,
    result: { kind: "written" },
  });
  expect(operations.files.get(MANAGED_AGENT_INSTRUCTIONS_PATH)).toBe(MANAGED_AGENT_INSTRUCTIONS);
});

test.each([
  [
    "the managed file is a symbolic link",
    MANAGED_AGENT_INSTRUCTIONS_PATH,
    "symbolic-link",
    "path-outside-root",
  ],
  ["the workspace root is a symbolic link", WORKSPACE_ROOT, "symbolic-link", "path-outside-root"],
  [
    "the managed path is a directory",
    MANAGED_AGENT_INSTRUCTIONS_PATH,
    "directory",
    "workspace-unavailable",
  ],
] as const)(
  "refuses to write the managed instructions when %s",
  async (_case, path, kind, code) => {
    const operations = new ManagedInstructionsOperations();
    operations.kinds.set(path, kind);

    await expect(Effect.runPromise(ensureManagedInstructions(operations))).resolves.toEqual({
      ok: false,
      error: { code },
    });
    expect(operations.files.size, "a refused write leaves the workspace as it was").toBe(0);
  },
);
