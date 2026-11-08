import * as Effect from "effect/Effect";
import { afterEach, expect, test, vi } from "vitest";
import { WORKSPACE_COMMAND_TIMEOUT_MS } from "../../src/workspace-command-timeout.js";
import {
  projectCloneSource,
  executeProjectProvisionRequest,
  parseProjectProvisionRequest,
  planProjectProvisionRequest,
  type ProjectProvisionRequest,
} from "../../src/workspace/commands/provision-project.js";
import type { Project } from "../../src/project-catalog.js";
import { projectDirectory, projectGitDirectory } from "../../src/workspace-layout.js";
import { sampleProjectOne, sampleProjectTwo } from "../project-fixtures.js";
import {
  workspaceEffects,
  type PromiseOperations,
  type CommandOutput,
  WorkspaceSyncIncomplete,
  type WorkspacePathKind,
} from "./promise-operations.js";

const projectOne = sampleProjectOne;

const projectTwo = sampleProjectTwo;

function provisionRequest(project: Project): ProjectProvisionRequest {
  return { kind: "provision-project", projectId: project.id, repositoryUrl: project.repositoryUrl };
}

class FakeProjectOperations implements PromiseOperations {
  readonly calls: string[] = [];
  readonly sources: string[] = [];
  exitCode = 0;
  commandFailure: Error | undefined;

  durableGitConfig: string | undefined =
    `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${projectOne.repositoryUrl}\n`;

  lstat(path: string): Promise<WorkspacePathKind | undefined> {
    this.calls.push(`lstat:${path}`);

    return Promise.resolve(this.kindOf(path));
  }

  private kindOf(path: string): WorkspacePathKind | undefined {
    if (path.startsWith(projectDirectory(projectOne.id)) && this.durableGitConfig === undefined) {
      return undefined;
    }

    return path.endsWith("/.git/config") ? "file" : "directory";
  }

  readFile(path: string): Promise<string> {
    this.calls.push(`read:${path}`);

    return this.durableGitConfig !== undefined && path.endsWith("/.git/config")
      ? Promise.resolve(this.durableGitConfig)
      : Promise.reject(new Error(`no durable file at ${path}`));
  }

  writeFile(path: string, content: string): Promise<void> {
    this.calls.push(`write:${path}:${content.length}`);

    return Promise.resolve();
  }

  runCommand(source: string, cwd: string): Promise<CommandOutput> {
    this.calls.push(`command:${cwd}`);
    this.sources.push(source);

    if (this.commandFailure !== undefined) return Promise.reject(this.commandFailure);

    return Promise.resolve({ stdout: "", stderr: "", exitCode: this.exitCode });
  }
}

function provision(operations: FakeProjectOperations, request: ProjectProvisionRequest) {
  return Effect.runPromise(
    executeProjectProvisionRequest({ operations: workspaceEffects(operations), request }),
  );
}

test("plans the clone from the resolved project the caller sent, and its directory from the id", () => {
  const parsed = parseProjectProvisionRequest(provisionRequest(projectOne));

  if ("ok" in parsed) {
    throw new Error("a catalog project must parse");
  }

  const planned = planProjectProvisionRequest(parsed);

  expect(parsed).toMatchObject({
    id: projectOne.id,
    repositoryUrl: projectOne.repositoryUrl,
  });
  expect(planned).toEqual({
    kind: "run-command",
    source: projectCloneSource(projectOne),
    cwd: "/",
    timeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS,
  });
  expect(
    planned,
    "the directory as well as the repository comes from the resolved project",
  ).not.toEqual(planProjectProvisionRequest(projectTwo));
});

test("runs the clone above the project root, then checks the clone is durable", async () => {
  const operations = new FakeProjectOperations();

  await expect(provision(operations, provisionRequest(projectOne))).resolves.toEqual({
    ok: true,
    result: { kind: "command", stdout: "", stderr: "", exitCode: 0 },
  });

  const gitDir = projectGitDirectory(projectOne.id);

  expect(operations.calls).toEqual([
    "command:/",
    `lstat:${projectDirectory(projectOne.id)}`,
    `lstat:${gitDir}`,
    `lstat:${gitDir}/config`,
    `read:${gitDir}/config`,
  ]);
  expect(operations.sources).toEqual([projectCloneSource(projectOne)]);
});

test("reports a failing clone with its exit code instead of continuing", async () => {
  const operations = new FakeProjectOperations();
  operations.exitCode = 128;

  await expect(provision(operations, provisionRequest(projectOne))).resolves.toEqual({
    ok: true,
    result: { kind: "command", stdout: "", stderr: "", exitCode: 128 },
  });
});

test.each([
  [
    "Computer's post-command sync did not complete",
    (operations: FakeProjectOperations) => {
      operations.commandFailure = new WorkspaceSyncIncomplete({
        message: "post-command sync pending",
      });
    },
  ],
  [
    "the durable store has no clone",
    (operations: FakeProjectOperations) => {
      operations.durableGitConfig = undefined;
    },
  ],
  [
    "the durable clone names another origin",
    (operations: FakeProjectOperations) => {
      operations.durableGitConfig = '[remote "origin"]\n\turl = https://github.com/sample/other\n';
    },
  ],
] as const)("a clone is not provisioned when %s", async (_case, arrange) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const operations = new FakeProjectOperations();
  arrange(operations);

  await expect(provision(operations, provisionRequest(projectOne))).resolves.toEqual({
    ok: false,
    error: { code: "workspace-sync-incomplete" },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("a clone command that cannot run is one workspace-unavailable failure", async () => {
  const operations = new FakeProjectOperations();
  operations.commandFailure = new Error("econnrefused while dialing the container");
  vi.spyOn(console, "error").mockImplementation(() => {});

  await expect(provision(operations, provisionRequest(projectOne))).resolves.toEqual({
    ok: false,
    error: { code: "workspace-unavailable" },
  });
});

test("refuses a repository URL that is not the project's, and a project id that is not an id", async () => {
  const operations = new FakeProjectOperations();

  for (const request of [
    {
      ...provisionRequest(projectOne),
      repositoryUrl: "https://example.invalid/attacker/repo.git",
    },
    { ...provisionRequest(projectOne), repositoryUrl: "git@github.com:a/b.git" },
    { ...provisionRequest(projectOne), projectId: "../../etc" },
  ]) {
    await expect(provision(operations, request)).resolves.toEqual({
      ok: false,
      error: { code: "invalid-request" },
    });
  }

  expect(operations.calls, "a refused provision request runs nothing").toEqual([]);
});
