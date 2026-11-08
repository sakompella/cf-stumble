import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { type CommandOutput } from "../../src/workspace/operations.js";
import {
  MANAGED_AGENT_INSTRUCTIONS,
  ensureManagedInstructions,
} from "../../src/workspace/managed-instructions.js";
import { MANAGED_AGENT_INSTRUCTIONS_PATH, WORKSPACE_ROOT } from "../../src/workspace-layout.js";
import {
  workspaceEffects,
  type PromiseOperations,
  type WorkspacePathKind,
} from "./promise-operations.js";

class ManagedInstructionsOperations implements PromiseOperations {
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

  await expect(
    Effect.runPromise(ensureManagedInstructions(workspaceEffects(operations))),
  ).resolves.toEqual({
    ok: true,
    result: { kind: "written" },
  });
  expect(operations.files.get(MANAGED_AGENT_INSTRUCTIONS_PATH)).toBe(MANAGED_AGENT_INSTRUCTIONS);
});

test("replaces a stale managed instructions file with the current text", async () => {
  const operations = new ManagedInstructionsOperations();
  operations.kinds.set(MANAGED_AGENT_INSTRUCTIONS_PATH, "file");
  operations.files.set(MANAGED_AGENT_INSTRUCTIONS_PATH, "# instructions from an older release\n");

  await expect(
    Effect.runPromise(ensureManagedInstructions(workspaceEffects(operations))),
  ).resolves.toEqual({
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

    await expect(
      Effect.runPromise(ensureManagedInstructions(workspaceEffects(operations))),
    ).resolves.toEqual({
      ok: false,
      error: { code },
    });
    expect(operations.files.size, "a refused write leaves the workspace as it was").toBe(0);
  },
);
