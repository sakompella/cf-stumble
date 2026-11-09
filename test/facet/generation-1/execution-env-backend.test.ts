import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { expect, test } from "vitest";
import { createComputerEnv } from "../../../src/facet/generation-1/execution-env.js";
import type {
  ProjectRpcTargetContract,
  StartExecWire,
} from "../../../src/workspace/project/protocol.js";

const refused = () => Promise.reject(new Error("not used"));

function recordingTarget(started: StartExecWire[]): ProjectRpcTargetContract {
  const exited = `${JSON.stringify({ kind: "terminal", seq: 0, outcome: "exited", exitCode: 0 })}\n`;

  return {
    lstat: refused,
    readFile: refused,
    writeFile: refused,
    kill: refused,
    endTurn: refused,
    startExec: (input) => {
      started.push(input);

      return Promise.resolve({
        ok: true,
        value: { operationId: "op", events: new Response(exited).body ?? new ReadableStream() },
      });
    },
  };
}

function streamingTarget(frames: readonly unknown[]): ProjectRpcTargetContract {
  const stream = new Response(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`).body;

  return {
    lstat: refused,
    readFile: refused,
    writeFile: () => Promise.resolve({ ok: true, value: null }),
    kill: refused,
    endTurn: refused,
    startExec: () =>
      Promise.resolve({
        ok: true,
        value: { operationId: "op", events: stream ?? new ReadableStream() },
      }),
  };
}

test("the env sends no backend by default and the chosen one when asked", async () => {
  const started: StartExecWire[] = [];
  const env = createComputerEnv({ cwd: "/workspace/project", target: recordingTarget(started) });

  getOrThrow(await env.exec("ls", {}, BACKGROUND_CONTEXT));
  getOrThrow(await env.onBackend("isolate").exec("ls", {}, BACKGROUND_CONTEXT));
  getOrThrow(await env.onBackend("container").exec("ls", {}, BACKGROUND_CONTEXT));

  expect(started.map((input) => input.backend)).toEqual([undefined, "isolate", "container"]);
});

test("the env names the workspace file that holds output the runtime cut", async () => {
  const env = createComputerEnv({
    cwd: "/workspace/project",
    target: streamingTarget([
      { kind: "stdout", seq: 0, data: "x".repeat(96) },
      {
        kind: "terminal",
        seq: 1,
        outcome: "exited",
        exitCode: 0,
        fullOutputPaths: [
          "/.cf-stumble/output/run-1.stdout.log",
          "/.cf-stumble/output/run-1.stderr.log",
        ],
      },
    ]),
  });

  const result = getOrThrow(
    await env.exec("noisy", { spill: { afterBytes: 8, afterLines: 8 } }, BACKGROUND_CONTEXT),
  );

  expect(result.exitCode).toBe(0);
  expect(result.spillPath).toBe(
    "/workspace/.cf-stumble/output/run-1.stdout.log, /workspace/.cf-stumble/output/run-1.stderr.log",
  );
});

test("the env spills output to its own file when the runtime cut nothing", async () => {
  const env = createComputerEnv({
    cwd: "/workspace/project",
    target: streamingTarget([
      { kind: "stdout", seq: 0, data: "abc\n" },
      { kind: "terminal", seq: 1, outcome: "exited", exitCode: 0 },
    ]),
  });

  const result = getOrThrow(
    await env.exec("short", { spill: { afterBytes: 1, afterLines: 1 } }, BACKGROUND_CONTEXT),
  );

  expect(result.exitCode).toBe(0);
  expect(result.spillPath?.startsWith("/workspace/.cf-stumble/tmp/")).toBe(true);
});

test("the env reports no spill for output that fits and the runtime did not cut", async () => {
  const env = createComputerEnv({
    cwd: "/workspace/project",
    target: streamingTarget([
      { kind: "stdout", seq: 0, data: "abc\n" },
      { kind: "terminal", seq: 1, outcome: "exited", exitCode: 0 },
    ]),
  });

  const result = getOrThrow(await env.exec("short", {}, BACKGROUND_CONTEXT));

  expect(result.exitCode).toBe(0);
  expect(result.spillPath).toBeUndefined();
});
