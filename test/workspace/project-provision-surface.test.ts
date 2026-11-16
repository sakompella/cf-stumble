import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import {
  CLONE_SIZE_VERDICTS,
  executeProjectProvisionRequest,
  type ProjectProvisionRequest,
} from "../../src/workspace/commands/provision-project.js";
import type { Project } from "../../src/project-catalog.js";
import { projectDirectory } from "../../src/workspace-layout.js";
import { sampleProjectOne, sampleProjectTwo } from "../project-fixtures.js";
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
  exitCode = 0;
  stdout = "";
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

  runCommand(_source: string, cwd: string): Promise<CommandOutput> {
    this.calls.push(`command:${cwd}`);

    if (this.commandFailure !== undefined) return Promise.reject(this.commandFailure);

    if (this.exitCode === 0) this.cloned = true;

    return Promise.resolve({ stdout: this.stdout, stderr: "", exitCode: this.exitCode });
  }
}

function provision(operations: FakeProjectOperations, request: ProjectProvisionRequest) {
  return Effect.runPromise(
    executeProjectProvisionRequest({ operations: workspaceEffects(operations), request }),
  );
}

test("without an isolate clone, the container clone runs from above the not yet existing project root", async () => {
  const operations = new FakeProjectOperations();

  await expect(provision(operations, provisionRequest(projectOne))).resolves.toEqual({
    ok: true,
  });

  expect(operations.calls.filter((call) => call.startsWith("command:"))).toEqual(["command:/"]);
});

test("reports a failing clone as clone-failed with its exit code instead of continuing", async () => {
  const operations = new FakeProjectOperations();
  operations.exitCode = 128;

  await expect(provision(operations, provisionRequest(projectOne))).resolves.toEqual({
    ok: false,
    error: { code: "clone-failed", exitCode: 128 },
  });
});

test.each(CLONE_SIZE_VERDICTS)(
  "a clone the script stopped for %s answers repository-too-large with that verdict",
  async (verdict) => {
    const operations = new FakeProjectOperations();
    operations.exitCode = 122;
    operations.stdout = `size-verdict=${verdict}\n`;

    await expect(provision(operations, provisionRequest(projectOne))).resolves.toEqual({
      ok: false,
      error: { code: "repository-too-large", verdict },
    });
  },
);

test("exit 122 without a verdict the script prints is a failed clone, not a size verdict", async () => {
  const operations = new FakeProjectOperations();
  operations.exitCode = 122;
  operations.stdout = "size-verdict=nonsense\n";

  await expect(provision(operations, provisionRequest(projectOne))).resolves.toEqual({
    ok: false,
    error: { code: "clone-failed", exitCode: 122 },
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
  const operations = new FakeProjectOperations();
  arrange(operations);

  await expect(provision(operations, provisionRequest(projectOne))).resolves.toEqual({
    ok: false,
    error: { code: "workspace-sync-incomplete" },
  });
});

test("a clone command that cannot run is one workspace-unavailable failure", async () => {
  const operations = new FakeProjectOperations();
  operations.commandFailure = new Error("econnrefused while dialing the container");

  await expect(provision(operations, provisionRequest(projectOne))).resolves.toEqual({
    ok: false,
    error: { code: "workspace-unavailable" },
  });
});

test("refuses a repository URL that is not the project's, an id its URL does not derive, and a project id that is not an id", async () => {
  const operations = new FakeProjectOperations();

  for (const request of [
    {
      ...provisionRequest(projectOne),
      repositoryUrl: "https://example.invalid/attacker/repo.git",
    },
    { ...provisionRequest(projectOne), repositoryUrl: "git@github.com:a/b.git" },
    { ...provisionRequest(projectOne), repositoryUrl: sampleProjectTwo.repositoryUrl },
    { ...provisionRequest(projectOne), projectId: "../../etc" },
  ]) {
    await expect(provision(operations, request)).resolves.toEqual({
      ok: false,
      error: { code: "invalid-request" },
    });
  }

  expect(operations.calls, "a refused provision request runs nothing").toEqual([]);
});
