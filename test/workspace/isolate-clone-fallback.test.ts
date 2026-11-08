import * as Effect from "effect/Effect";
import { afterEach, expect, test, vi } from "vitest";
import { executeProjectProvisionRequest } from "../../src/workspace/executor.js";
import { sampleProjectOne } from "../project-fixtures.js";
import { workspaceEffects, type PromiseOperations } from "./promise-operations.js";

const project = sampleProjectOne;

const request = {
  kind: "provision-project",
  projectId: project.id,
  repositoryUrl: project.repositoryUrl,
} as const;

type Clone = (state: { cloned: boolean }) => Promise<void>;

function workspaceWith(cloned: boolean, clone: Clone) {
  const commands: string[] = [];
  const state = { cloned };
  const cloneProject = vi.fn(() => clone(state));

  const operations: PromiseOperations = {
    cloneProject,
    lstat: (path) =>
      Promise.resolve(
        state.cloned ? (path.endsWith("/.git/config") ? "file" : "directory") : undefined,
      ),
    readFile: () => Promise.resolve(`[remote "origin"]\n\turl = ${project.repositoryUrl}\n`),
    writeFile: () => Promise.resolve(),
    runCommand: (source) => {
      commands.push(source);
      state.cloned = true;

      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    },
  };

  return {
    operations,
    commands,
    cloneProject,
    run: () =>
      Effect.runPromise(
        executeProjectProvisionRequest({ operations: workspaceEffects(operations), request }),
      ),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("an isolate clone provisions the project without running a command", async () => {
  const { run, commands, cloneProject } = workspaceWith(false, (state) => {
    state.cloned = true;

    return Promise.resolve();
  });

  await expect(run()).resolves.toMatchObject({ ok: true, result: { exitCode: 0 } });
  expect(cloneProject).toHaveBeenCalledTimes(1);
  expect(commands).toEqual([]);
});

test("a project that is already cloned is neither cloned nor run again", async () => {
  const { run, commands, cloneProject } = workspaceWith(true, () => Promise.resolve());

  await run();

  expect(cloneProject).not.toHaveBeenCalled();
  expect(commands).toEqual([]);
});

test.each([
  ["fails", () => Promise.reject(new Error("401 Unauthorized")), "401 Unauthorized"],
  ["leaves no clone behind", () => Promise.resolve(), "the clone ran but its markers are missing"],
])("the container clone runs when the isolate clone %s", async (_case, clone, reason) => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { run, commands } = workspaceWith(false, clone);

  await expect(run()).resolves.toMatchObject({ ok: true });
  expect(commands).toHaveLength(1);
  expect(error).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(
    expect.objectContaining({ event: "workspace.isolate-clone.fell-back", level: "warn", reason }),
  );
});
