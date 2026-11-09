import * as Effect from "effect/Effect";
import { afterEach, expect, test, vi } from "vitest";
import {
  projectCloneSource,
  executeProjectProvisionRequest,
  type ProjectProvisionRequest,
} from "../../src/workspace/commands/provision-project.js";
import type { Project } from "../../src/project-catalog.js";
import { projectDirectory, projectGitDirectory } from "../../src/workspace-layout.js";
import { sampleProjectOne } from "../project-fixtures.js";
import {
  workspaceEffects,
  type PromiseOperations,
  type CommandOutput,
  WorkspaceSyncIncomplete,
  type WorkspacePathKind,
} from "./promise-operations.js";

const projectOne = sampleProjectOne;

function provisionRequest(project: Project): ProjectProvisionRequest {
  return { kind: "provision-project", projectId: project.id, repositoryUrl: project.repositoryUrl };
}

class FakeProjectOperations implements PromiseOperations {
  readonly calls: string[] = [];
  readonly sources: string[] = [];
  exitCode = 0;
  commandFailure: Error | undefined;
  cloneFailure: Error | undefined = new Error("the isolate clone is unavailable");
  private cloned = false;

  durableGitConfig: string | undefined =
    `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${projectOne.repositoryUrl}\n`;

  cloneProject(_project: Project): Promise<void> {
    this.calls.push("clone");

    return this.cloneFailure === undefined ? Promise.resolve() : Promise.reject(this.cloneFailure);
  }

  lstat(path: string): Promise<WorkspacePathKind | undefined> {
    this.calls.push(`lstat:${path}`);

    return Promise.resolve(this.kindOf(path));
  }

  private kindOf(path: string): WorkspacePathKind | undefined {
    if (!this.cloned) return undefined;

    if (path.startsWith(projectDirectory(projectOne.id)) && this.durableGitConfig === undefined) {
      return undefined;
    }

    return path.endsWith("/.git/config") ? "file" : "directory";
  }

  readFile(path: string): Promise<string> {
    this.calls.push(`read:${path}`);

    return this.cloned && this.durableGitConfig !== undefined && path.endsWith("/.git/config")
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

    if (this.exitCode === 0) this.cloned = true;

    return Promise.resolve({ stdout: "", stderr: "", exitCode: this.exitCode });
  }
}

function provision(operations: FakeProjectOperations, request: ProjectProvisionRequest) {
  return Effect.runPromise(
    executeProjectProvisionRequest({ operations: workspaceEffects(operations), request }),
  );
}

test("runs the clone above the project root, then checks the clone is durable", async () => {
  const operations = new FakeProjectOperations();

  await expect(provision(operations, provisionRequest(projectOne))).resolves.toEqual({
    ok: true,
    result: { kind: "command", stdout: "", stderr: "", exitCode: 0 },
  });

  const gitDir = projectGitDirectory(projectOne.id);

  expect(operations.calls).toEqual([
    `lstat:${projectDirectory(projectOne.id)}`,
    "clone",
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
