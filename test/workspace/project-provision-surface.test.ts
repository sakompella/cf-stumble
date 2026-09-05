import { expect, test } from "vitest";
import {
  MANAGED_AGENT_INSTRUCTIONS,
  planProjectProvision,
  projectProvisionConfiguration,
  projectProvisionStep,
} from "../../src/project-provision.js";
import { MANAGED_AGENT_INSTRUCTIONS_PATH, WORKSPACE_ROOT } from "../../src/workspace-layout.js";
import { PROJECT_CATALOG } from "../../src/project-catalog.js";
import {
  executeProjectProvisionRequest,
  executeWorkspaceRequest,
  parseProjectProvisionRequest,
  planProjectProvisionRequest,
  type CommandOutput,
  type WorkspaceConfiguration,
  type WorkspaceOperations,
  type WorkspacePathKind,
} from "../../src/workspace/index.js";

/**
 * The provision surface's parsing and planning, and the shell it hands to Computer. No test here
 * runs that shell — the Workers pool has no `node:child_process` — so what a green run shows is
 * which requests are refused, which paths are reachable, and what text the accepted ones produce.
 */

const [projectOne, projectTwo] = PROJECT_CATALOG;

/** The prefixes the executor stats before it writes, which is one per path component. */
function pathParts(path: string): string[] {
  const prefixes: string[] = [];
  let current = "";
  for (const part of path.split("/").filter((segment) => segment.length > 0)) {
    current += `/${part}`;
    prefixes.push(current);
  }
  return prefixes;
}

function cloneSource(): string {
  const step = projectProvisionStep(
    planProjectProvision(projectProvisionConfiguration(projectOne.id), projectOne),
    "clone",
  );
  if (step.name !== "clone") {
    throw new Error("the clone step must be the command step");
  }

  return step.source;
}

const projectConfiguration = {
  root: WORKSPACE_ROOT,
  commands: { check: "./test.sh" },
} as const satisfies WorkspaceConfiguration;

class FakeProjectOperations implements WorkspaceOperations {
  readonly calls: string[] = [];
  readonly sources: string[] = [];
  readonly symlinks = new Set<string>();
  exitCode = 0;

  lstat(path: string): Promise<WorkspacePathKind | undefined> {
    this.calls.push(`lstat:${path}`);
    return Promise.resolve(this.symlinks.has(path) ? "symbolic-link" : "directory");
  }

  readFile(path: string): Promise<string> {
    this.calls.push(`read:${path}`);
    return Promise.reject(new Error("provisioning never reads through the workspace surface"));
  }

  writeFile(path: string, content: string): Promise<void> {
    this.calls.push(`write:${path}:${content.length}`);
    return Promise.resolve();
  }

  listFiles(path: string): Promise<readonly string[]> {
    this.calls.push(`list:${path}`);
    return Promise.reject(new Error("provisioning never lists through the workspace surface"));
  }

  runCommand(source: string, cwd: string): Promise<CommandOutput> {
    this.calls.push(`command:${cwd}`);
    this.sources.push(source);
    return Promise.resolve({ stdout: "", stderr: "", exitCode: this.exitCode });
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This helper passes test values to the public parsing boundary.
function provision(operations: FakeProjectOperations, request: unknown) {
  return executeProjectProvisionRequest({ operations, request });
}

test("resolves the repository from the catalog, not from the request", () => {
  const parsed = parseProjectProvisionRequest({
    kind: "provision-project",
    projectId: projectOne.id,
    step: "clone",
  });
  if ("ok" in parsed) {
    throw new Error("a catalog project and a planned step must parse");
  }

  const planned = planProjectProvisionRequest(parsed);

  expect(parsed.project).toEqual(projectOne);
  expect(planned).toEqual({ kind: "run-command", source: cloneSource(), cwd: "/" });
  expect(
    planned,
    "the directory as well as the repository comes from the resolved project",
  ).not.toEqual(planProjectProvisionRequest({ ...parsed, project: projectTwo }));
});

test("plans the managed instructions as a file the server decides", () => {
  const parsed = parseProjectProvisionRequest({
    kind: "provision-project",
    projectId: projectTwo.id,
    step: "instructions",
  });
  if ("ok" in parsed) {
    throw new Error("a catalog project and a planned step must parse");
  }

  expect(planProjectProvisionRequest(parsed)).toEqual({
    kind: "write-file",
    path: MANAGED_AGENT_INSTRUCTIONS_PATH,
    content: MANAGED_AGENT_INSTRUCTIONS,
  });
});

test("runs the clone above the project root and writes the instructions beside it", async () => {
  const operations = new FakeProjectOperations();

  await expect(
    provision(operations, { kind: "provision-project", projectId: projectOne.id, step: "clone" }),
  ).resolves.toEqual({
    ok: true,
    result: { kind: "command", stdout: "", stderr: "", exitCode: 0 },
  });
  await expect(
    provision(operations, {
      kind: "provision-project",
      projectId: projectOne.id,
      step: "instructions",
    }),
  ).resolves.toEqual({ ok: true, result: { kind: "written" } });

  expect(operations.calls).toEqual([
    "command:/",
    ...pathParts(MANAGED_AGENT_INSTRUCTIONS_PATH).map((prefix) => `lstat:${prefix}`),
    `write:${MANAGED_AGENT_INSTRUCTIONS_PATH}:${MANAGED_AGENT_INSTRUCTIONS.length}`,
  ]);
  expect(operations.sources).toEqual([cloneSource()]);
});

test("reports a failing clone with its exit code instead of continuing", async () => {
  const operations = new FakeProjectOperations();
  operations.exitCode = 128;

  await expect(
    provision(operations, { kind: "provision-project", projectId: projectOne.id, step: "clone" }),
  ).resolves.toEqual({
    ok: true,
    result: { kind: "command", stdout: "", stderr: "", exitCode: 128 },
  });
});

test("refuses a caller supplied repository URL, command, or project", async () => {
  const operations = new FakeProjectOperations();

  for (const [request, code] of [
    [null, "invalid-request"],
    [{ kind: "provision-project", projectId: projectOne.id }, "invalid-request"],
    [
      {
        kind: "provision-project",
        projectId: projectOne.id,
        step: "clone",
        repositoryUrl: "https://example.invalid/attacker/repo.git",
      },
      "invalid-request",
    ],
    [
      { kind: "provision-project", projectId: projectOne.id, step: "clone", source: "whoami" },
      "invalid-request",
    ],
    [{ kind: "provision-project", projectId: "no-such-project", step: "clone" }, "invalid-request"],
    [{ kind: "provision-project", projectId: "../../etc", step: "clone" }, "invalid-request"],
    [{ kind: "provision-project", projectId: 7, step: "clone" }, "invalid-request"],
    [{ kind: "run-command", command: "check" }, "invalid-request"],
    [{ kind: "read-file", path: "readme.md" }, "invalid-request"],
    [{ kind: "provision-project", projectId: projectOne.id, step: "whoami" }, "unknown-command"],
  ] as const) {
    await expect(provision(operations, request)).resolves.toEqual({ ok: false, error: { code } });
  }

  expect(operations.calls, "a refused provision request runs nothing").toEqual([]);
});

test("refuses managed instructions reached through a symbolic link", async () => {
  const operations = new FakeProjectOperations();
  operations.symlinks.add(MANAGED_AGENT_INSTRUCTIONS_PATH);

  await expect(
    provision(operations, {
      kind: "provision-project",
      projectId: projectOne.id,
      step: "instructions",
    }),
  ).resolves.toEqual({ ok: false, error: { code: "path-outside-root" } });
  expect(operations.calls.every((call) => call.startsWith("lstat:"))).toBe(true);
});

test("keeps provisioning out of the project surface and its check command", async () => {
  const operations = new FakeProjectOperations();

  await expect(
    executeWorkspaceRequest({
      configuration: projectConfiguration,
      operations,
      request: { kind: "provision-project", projectId: projectOne.id, step: "clone" },
    }),
  ).resolves.toEqual({ ok: false, error: { code: "invalid-request" } });
  await expect(
    executeWorkspaceRequest({
      configuration: projectConfiguration,
      operations,
      request: { kind: "run-command", command: "clone" },
    }),
  ).resolves.toEqual({ ok: false, error: { code: "unknown-command" } });

  expect(Object.keys(projectConfiguration.commands)).toEqual(["check"]);
  expect(projectConfiguration.commands.check).toBe("./test.sh");
  expect(operations.calls).toEqual([]);
});
