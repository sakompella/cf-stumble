import * as Effect from "effect/Effect";
import { afterEach, expect, test, vi } from "vitest";
import { WORKSPACE_COMMAND_TIMEOUT_MS } from "../../src/workspace-command-timeout.js";
import {
  executeProjectRemovalRequest,
  parseProjectRemovalRequest,
  planProjectRemovalRequest,
  type ProjectRemovalRequest,
} from "../../src/workspace/commands/remove-project.js";
import { projectDirectory } from "../../src/workspace-layout.js";
import { shellQuote } from "../../src/shell-quote.js";
import { sampleProjectOne } from "../project-fixtures.js";
import {
  workspaceEffects,
  type PromiseOperations,
  type CommandOutput,
  WorkspaceSyncIncomplete,
  type WorkspacePathKind,
} from "./promise-operations.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const request: ProjectRemovalRequest = {
  kind: "remove-project",
  projectId: sampleProjectOne.id,
};

class FakeOperations implements PromiseOperations {
  readonly sources: string[] = [];
  readonly statted: string[] = [];
  readonly remaining = new Set<string>();
  syncFailure: WorkspaceSyncIncomplete | undefined;

  lstat(path: string): Promise<WorkspacePathKind | undefined> {
    this.statted.push(path);

    return Promise.resolve(this.remaining.has(path) ? "directory" : undefined);
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

test("derives the removal from the project id and removes only the clone and staging directory", async () => {
  const parsed = parseProjectRemovalRequest(request);

  expect(parsed).toEqual(request);

  if ("ok" in parsed) throw new Error("the valid removal request must parse");

  const plan = planProjectRemovalRequest(parsed);

  expect(plan.kind).toBe("run-command");
  expect(plan.cwd).toBe("/");
  expect(plan.timeoutMs).toBe(WORKSPACE_COMMAND_TIMEOUT_MS);

  const operations = new FakeOperations();

  await expect(
    Effect.runPromise(
      executeProjectRemovalRequest({ operations: workspaceEffects(operations), request }),
    ),
  ).resolves.toEqual({
    ok: true,
    result: { kind: "command", stdout: "", stderr: "", exitCode: 0 },
  });

  expect(operations.sources).toHaveLength(1);
  expect(operations.statted, "the durable store is checked for both directories").toEqual([
    projectDirectory(sampleProjectOne.id),
    `${projectDirectory(sampleProjectOne.id)}.provisioning`,
  ]);
  expect(operations.sources[0]?.split("\n").at(-1)).toBe(
    `rm -rf -- ${shellQuote(projectDirectory(sampleProjectOne.id))} ${shellQuote(`${projectDirectory(sampleProjectOne.id)}.provisioning`)}`,
  );
  expect(operations.sources[0]).not.toContain("/workspace/harness");
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
    "the durable store still holds the clone",
    (operations: FakeOperations) => {
      operations.remaining.add(projectDirectory(sampleProjectOne.id));
    },
  ],
  [
    "the durable store still holds the staging directory",
    (operations: FakeOperations) => {
      operations.remaining.add(`${projectDirectory(sampleProjectOne.id)}.provisioning`);
    },
  ],
] as const)("a removal is not reported as done when %s", async (_case, arrange) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
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
