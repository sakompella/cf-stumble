import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { executeProjectProvisionRequest } from "../../src/workspace/commands/provision-project.js";
import { capturedEvents, named } from "../log-capture.js";
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
  const state = { cloned, isolateClones: 0 };

  const operations: PromiseOperations = {
    cloneProject: () => {
      state.isolateClones += 1;

      return clone(state);
    },
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
    state,
    commands,
    run: () =>
      Effect.runPromise(
        executeProjectProvisionRequest({ operations: workspaceEffects(operations), request }),
      ),
  };
}

test("an isolate clone provisions the project without a container command", async () => {
  const { run, commands } = workspaceWith(false, (state) => {
    state.cloned = true;

    return Promise.resolve();
  });

  await expect(run()).resolves.toEqual({ ok: true });
  expect(commands).toEqual([]);
});

test("a project that is already cloned is neither cloned nor run again", async () => {
  const { run, commands, state } = workspaceWith(true, () => Promise.resolve());

  await expect(run()).resolves.toEqual({ ok: true });
  expect(state.isolateClones).toBe(0);
  expect(commands).toEqual([]);
});

test.each([
  ["fails", () => Promise.reject(new Error("401 Unauthorized")), "401 Unauthorized"],
  ["leaves no clone behind", () => Promise.resolve(), ""],
])(
  "the container clone runs when the isolate clone %s, and the fallback is logged",
  async (_case, clone, reason) => {
    const events = capturedEvents();
    const { run, commands } = workspaceWith(false, clone);

    await expect(run()).resolves.toEqual({ ok: true });
    expect(commands).toHaveLength(1);

    const fellBack = named(events(), "workspace.isolate-clone.fell-back");

    expect(fellBack.map((event) => event.level)).toEqual(["warn"]);
    expect(String(fellBack[0]?.reason)).toContain(reason);
  },
);
