import * as Effect from "effect/Effect";
import { afterEach, expect, test, vi } from "vitest";
import { WORKSPACE_COMMAND_TIMEOUT_MS } from "../../src/workspace-command-timeout.js";
import {
  planProjectProvision,
  projectProvisionStep,
  type ProjectProvisionStepName,
} from "../../src/project-provision.js";
import type { Project } from "../../src/project-catalog.js";
import { projectDirectory, projectGitDirectory } from "../../src/workspace-layout.js";
import { sampleProjectOne, sampleProjectTwo } from "../project-fixtures.js";
import {
  executeProjectProvisionRequest,
  parseProjectProvisionRequest,
  planProjectProvisionRequest,
  WorkspaceSyncIncomplete,
  type CommandOutput,
  type ProjectProvisionRequest,
  type WorkspaceOperations,
  type WorkspacePathKind,
} from "../../src/workspace/index.js";

/**
 * The provision surface's parsing and planning, and the shell it hands to Computer. No test here
 * runs that shell — the Workers pool has no `node:child_process` — so what a green run shows is
 * which requests are refused, which paths are reachable, and what text the accepted ones produce.
 */

const projectOne = sampleProjectOne;

const projectTwo = sampleProjectTwo;

/** One provision request, as the Supervisor sends it: the project it resolved, and a step. */
function provisionRequest(
  project: Project,
  step: ProjectProvisionStepName,
): ProjectProvisionRequest {
  return {
    kind: "provision-project",
    projectId: project.id,
    repositoryUrl: project.repositoryUrl,
    step,
  };
}

function cloneSource(): string {
  return projectProvisionStep(planProjectProvision(projectOne), "clone").source;
}

class FakeProjectOperations implements WorkspaceOperations {
  readonly calls: string[] = [];
  readonly sources: string[] = [];
  exitCode = 0;
  /** When set, `runCommand` rejects with this instead of resolving. A test uses this to prove
   * the provision shell's catch-all logs a redacted cause instead of discarding it. */
  commandFailure: Error | undefined;

  /** The Git config the durable store holds for the clone, or nothing when the clone is absent. */
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

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This helper passes test values to the public parsing boundary.
function provision(operations: FakeProjectOperations, request: unknown) {
  return Effect.runPromise(executeProjectProvisionRequest({ operations, request }));
}

test("plans the clone from the resolved project the caller sent, and its directory from the id", () => {
  const parsed = parseProjectProvisionRequest(provisionRequest(projectOne, "clone"));

  if ("ok" in parsed) {
    throw new Error("a catalog project and a planned step must parse");
  }

  const planned = planProjectProvisionRequest(parsed);

  expect(parsed.project).toMatchObject({
    id: projectOne.id,
    repositoryUrl: projectOne.repositoryUrl,
  });
  expect(planned).toEqual({
    kind: "run-command",
    source: cloneSource(),
    cwd: "/",
    timeoutMs: WORKSPACE_COMMAND_TIMEOUT_MS,
  });
  expect(
    planned,
    "the directory as well as the repository comes from the resolved project",
  ).not.toEqual(planProjectProvisionRequest({ ...parsed, project: projectTwo }));
});

test("runs the clone above the project root, then checks the clone is durable", async () => {
  const operations = new FakeProjectOperations();

  await expect(provision(operations, provisionRequest(projectOne, "clone"))).resolves.toEqual({
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
  expect(operations.sources).toEqual([cloneSource()]);
});

test("reports a failing clone with its exit code instead of continuing", async () => {
  const operations = new FakeProjectOperations();
  operations.exitCode = 128;

  await expect(provision(operations, provisionRequest(projectOne, "clone"))).resolves.toEqual({
    ok: true,
    result: { kind: "command", stdout: "", stderr: "", exitCode: 128 },
  });
});

test.each([
  [
    "Computer's post-command sync did not complete",
    (operations: FakeProjectOperations) => {
      operations.commandFailure = new WorkspaceSyncIncomplete("post-command sync pending");
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

  await expect(provision(operations, provisionRequest(projectOne, "clone"))).resolves.toEqual({
    ok: false,
    error: { code: "workspace-sync-incomplete" },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The provision shell's catch-all used to discard whatever Computer threw and answer
 * `workspace-unavailable` with nothing logged, same as the build shell's. The public code stays
 * generic; an operator can now read the cause the catch-all just swallowed.
 */
test("logs a redacted cause instead of discarding it when the clone command cannot run", async () => {
  const operations = new FakeProjectOperations();
  operations.commandFailure = new Error("econnrefused while dialing the container");
  const loggedErrors = vi.spyOn(console, "error").mockImplementation(() => {});

  await expect(provision(operations, provisionRequest(projectOne, "clone"))).resolves.toEqual({
    ok: false,
    error: { code: "workspace-unavailable" },
  });

  expect(loggedErrors, "the discarded cause must reach an operator log").toHaveBeenCalledTimes(1);
  const logged = loggedErrors.mock.calls[0]?.join(" ") ?? "";
  expect(logged).toContain("workspace-unavailable");
  expect(logged).toContain("econnrefused while dialing the container");
});

test("refuses a caller supplied repository URL, command, or project", async () => {
  const operations = new FakeProjectOperations();

  for (const [request, code] of [
    [null, "invalid-request"],
    [{ kind: "provision-project", projectId: projectOne.id }, "invalid-request"],
    [
      {
        ...provisionRequest(projectOne, "clone"),
        repositoryUrl: "https://example.invalid/attacker/repo.git",
      },
      "invalid-request",
    ],
    [{ ...provisionRequest(projectOne, "clone"), source: "whoami" }, "invalid-request"],
    [
      { ...provisionRequest(projectOne, "clone"), repositoryUrl: "git@github.com:a/b.git" },
      "invalid-request",
    ],
    [{ ...provisionRequest(projectOne, "clone"), projectId: "../../etc" }, "invalid-request"],
    [{ ...provisionRequest(projectOne, "clone"), projectId: 7 }, "invalid-request"],
    [{ kind: "run-command", command: "check" }, "invalid-request"],
    [{ kind: "read-file", path: "readme.md" }, "invalid-request"],
    [{ ...provisionRequest(projectOne, "clone"), step: "whoami" }, "unknown-command"],
    [{ ...provisionRequest(projectOne, "clone"), step: "instructions" }, "unknown-command"],
  ] as const) {
    await expect(provision(operations, request)).resolves.toEqual({ ok: false, error: { code } });
  }

  expect(operations.calls, "a refused provision request runs nothing").toEqual([]);
});
