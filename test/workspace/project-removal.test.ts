import * as Effect from "effect/Effect";
import { afterEach, expect, test, vi } from "vitest";
import { WORKSPACE_COMMAND_TIMEOUT_MS } from "../../src/workspace-command-timeout.js";
import {
  executeProjectRemovalRequest,
  parseProjectRemovalRequest,
  planProjectRemovalRequest,
  WorkspaceSyncIncomplete,
  type ProjectRemovalRequest,
  type WorkspaceOperations,
  type WorkspacePathKind,
  type CommandOutput,
} from "../../src/workspace/index.js";
import { projectDirectory } from "../../src/workspace-layout.js";
import { holdProvisionLock, projectProvisionLockPath } from "../../src/project-provision.js";
import { shellQuote } from "../../src/shell-quote.js";
import { sampleProjectOne } from "../project-fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const request: ProjectRemovalRequest = {
  kind: "remove-project",
  projectId: sampleProjectOne.id,
};

class FakeOperations implements WorkspaceOperations {
  readonly sources: string[] = [];
  readonly statted: string[] = [];
  /** Durable store paths that are still present after the removal command. */
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

test("derives project removal paths from the project id", () => {
  const parsed = parseProjectRemovalRequest(request);

  expect(parsed).toEqual(request);

  if ("ok" in parsed) throw new Error("the valid removal request must parse");

  const plan = planProjectRemovalRequest(parsed);

  expect(plan.kind).toBe("run-command");
  expect(plan.cwd).toBe("/");
  expect(plan.timeoutMs).toBe(WORKSPACE_COMMAND_TIMEOUT_MS);
  expect(plan.source).toContain(projectDirectory(sampleProjectOne.id));
  expect(plan.source).toContain(`${projectDirectory(sampleProjectOne.id)}.provisioning`);
});

test("refuses malformed and harness removal requests", async () => {
  const operations = new FakeOperations();

  for (const value of [
    null,
    { kind: "remove-project", projectId: "../../etc" },
    { kind: "remove-project", projectId: "harness" },
    { kind: "remove-project", projectId: sampleProjectOne.id, extra: true },
  ]) {
    await expect(
      Effect.runPromise(executeProjectRemovalRequest({ operations, request: value })),
    ).resolves.toMatchObject({
      ok: false,
    });
  }

  expect(operations.sources).toEqual([]);
});

test("removes only the clone and staging directory", async () => {
  const operations = new FakeOperations();

  await expect(
    Effect.runPromise(executeProjectRemovalRequest({ operations, request })),
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

test("holds the project's container-local lock before removing anything", () => {
  const plan = planProjectRemovalRequest({
    kind: "remove-project",
    projectId: sampleProjectOne.id,
  });

  const lock = projectProvisionLockPath(sampleProjectOne.id);

  expect(lock.startsWith("/tmp/")).toBe(true);
  expect(plan.source).toContain(`lock=${shellQuote(lock)}\n${holdProvisionLock().join("\n")}\n`);
  const removal = plan.source.split("\n").find((line) => line.startsWith("rm -rf --"));

  expect(plan.source.indexOf("flock 9")).toBeLessThan(plan.source.indexOf("rm -rf --"));
  expect(removal, "the lock file is never deleted").not.toContain(lock);
});

test.each([
  [
    "Computer's post-command sync did not complete",
    (operations: FakeOperations) => {
      operations.syncFailure = new WorkspaceSyncIncomplete("post-command sync pending");
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
    Effect.runPromise(executeProjectRemovalRequest({ operations, request })),
  ).resolves.toEqual({
    ok: false,
    error: { code: "workspace-sync-incomplete" },
  });
});
