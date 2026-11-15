import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import {
  executeProjectRemovalRequest,
  type ProjectRemovalRequest,
} from "../../src/workspace/commands/remove-project.js";
import { projectDirectory } from "../../src/workspace-layout.js";
import { sampleProjectOne } from "../project-fixtures.js";
import {
  workspaceEffects,
  type PromiseOperations,
  type CommandOutput,
  WorkspaceSyncIncomplete,
  type WorkspacePathKind,
} from "./promise-operations.js";

const request: ProjectRemovalRequest = {
  kind: "remove-project",
  projectId: sampleProjectOne.id,
};

class FakeOperations implements PromiseOperations {
  readonly sources: string[] = [];
  readonly remaining = new Set<string>();
  treesStay = false;
  syncFailure: WorkspaceSyncIncomplete | undefined;

  lstat(path: string): Promise<WorkspacePathKind | undefined> {
    return Promise.resolve(this.remaining.has(path) ? "directory" : undefined);
  }

  removeTree(path: string): Promise<void> {
    if (!this.treesStay) this.remaining.delete(path);

    return Promise.resolve();
  }

  readFile(): Promise<string> {
    return Promise.reject(new Error("removal does not read files"));
  }

  writeFile(): Promise<void> {
    return Promise.reject(new Error("removal does not write files"));
  }

  runCommand(source: string): Promise<CommandOutput> {
    this.sources.push(source);

    if (this.syncFailure !== undefined) return Promise.reject(this.syncFailure);

    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

test("refuses an invalid project id and the harness", async () => {
  const operations = new FakeOperations();

  for (const value of [
    { kind: "remove-project", projectId: "../../etc" },
    { kind: "remove-project", projectId: "harness" },
  ] as const) {
    await expect(
      Effect.runPromise(
        executeProjectRemovalRequest({ operations: workspaceEffects(operations), request: value }),
      ),
    ).resolves.toMatchObject({
      ok: false,
    });
  }

  expect(operations.sources).toEqual([]);
});

test("a removal answers done once the store holds neither the clone nor its staging directory", async () => {
  const operations = new FakeOperations();

  await expect(
    Effect.runPromise(
      executeProjectRemovalRequest({ operations: workspaceEffects(operations), request }),
    ),
  ).resolves.toEqual({
    ok: true,
    result: { kind: "command", stdout: "", stderr: "", exitCode: 0 },
  });
});

test.each([
  [
    "Computer's post-command sync did not complete",
    (operations: FakeOperations) => {
      operations.syncFailure = new WorkspaceSyncIncomplete({
        message: "post-command sync pending",
      });
    },
  ],
  [
    "the durable store still holds the clone after it was removed from the store",
    (operations: FakeOperations) => {
      operations.remaining.add(projectDirectory(sampleProjectOne.id));
      operations.treesStay = true;
    },
  ],
  [
    "the durable store still holds the staging directory after it was removed from the store",
    (operations: FakeOperations) => {
      operations.remaining.add(`${projectDirectory(sampleProjectOne.id)}.provisioning`);
      operations.treesStay = true;
    },
  ],
] as const)("a removal is not reported as done when %s", async (_case, arrange) => {
  const operations = new FakeOperations();
  arrange(operations);

  await expect(
    Effect.runPromise(
      executeProjectRemovalRequest({ operations: workspaceEffects(operations), request }),
    ),
  ).resolves.toEqual({
    ok: false,
    error: { code: "workspace-sync-incomplete" },
  });
});

test("directories that the command left in the durable store are removed from the store", async () => {
  const operations = new FakeOperations();
  const clone = projectDirectory(sampleProjectOne.id);
  operations.remaining.add(clone);

  await expect(
    Effect.runPromise(
      executeProjectRemovalRequest({ operations: workspaceEffects(operations), request }),
    ),
  ).resolves.toMatchObject({ ok: true, result: { exitCode: 0 } });

  expect(operations.remaining.has(clone)).toBe(false);
});
