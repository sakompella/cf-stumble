import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { expect, test } from "vitest";
import { createComputerEnv } from "../../../src/facet/generation-1/execution-env.js";
import type {
  ProjectResult,
  ProjectRpcTargetContract,
  StartExecWire,
  WriteMode,
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

function streamingTarget(
  frames: readonly unknown[],
  saved: Readonly<Record<string, string>> = {},
): ProjectRpcTargetContract {
  const stream = new Response(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`).body;
  const files = new Map(Object.entries(saved).map(([path, text]) => [path, text]));

  const readFile = (path: string): Promise<ProjectResult<Uint8Array>> => {
    const text = files.get(path);

    return Promise.resolve(
      text === undefined
        ? { ok: false, error: { code: "not-found", path } }
        : { ok: true, value: new TextEncoder().encode(text) },
    );
  };

  const writeFile = (
    path: string,
    bytes: Uint8Array,
    mode: WriteMode,
  ): Promise<ProjectResult<null>> => {
    const existing = files.get(path);

    if (mode === "create-exclusive" && existing !== undefined) {
      return Promise.resolve({ ok: false, error: { code: "already-exists", path } });
    }

    if (mode === "append" && existing !== undefined) {
      const combined = new Uint8Array(existing.length + bytes.length);
      combined.set(new TextEncoder().encode(existing));
      combined.set(bytes, existing.length);
      files.set(path, new TextDecoder().decode(combined));
    } else {
      files.set(path, new TextDecoder().decode(bytes));
    }

    return Promise.resolve({ ok: true, value: null });
  };

  return {
    lstat: refused,
    readFile,
    writeFile,
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

test("the env names its own spill file when the runtime cut the output", async () => {
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
  expect(result.spillPath?.startsWith("/workspace/.cf-stumble/tmp/pi-output-")).toBe(true);
  expect(getOrThrow(await env.readTextFile(result.spillPath ?? "", BACKGROUND_CONTEXT))).toBe(
    "x".repeat(96),
  );
});

test("the env names the saved runtime file when it spilled nothing of its own", async () => {
  const env = createComputerEnv({
    cwd: "/workspace/project",
    target: streamingTarget(
      [
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
      ],
      { "/.cf-stumble/output/run-1.stdout.log": "x".repeat(96) },
    ),
  });

  const result = getOrThrow(await env.exec("noisy", {}, BACKGROUND_CONTEXT));

  expect(result.exitCode).toBe(0);
  expect(result.spillPath).toBe("/workspace/.cf-stumble/output/run-1.stdout.log");
  expect(getOrThrow(await env.readTextFile(result.spillPath ?? "", BACKGROUND_CONTEXT))).toBe(
    "x".repeat(96),
  );
});

test("the env spills output to a file it can read back when the runtime cut nothing", async () => {
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
  expect(getOrThrow(await env.readTextFile(result.spillPath ?? "", BACKGROUND_CONTEXT))).toBe(
    "abc\n",
  );
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

test("a command the container restart ended names container-restarted to the model", async () => {
  const env = createComputerEnv({
    cwd: "/workspace/project",
    target: streamingTarget([
      { kind: "terminal", seq: 0, outcome: "failed", error: { code: "container-restarted" } },
    ]),
  });

  const result = await env.exec("make", {}, BACKGROUND_CONTEXT);

  expect(result.ok).toBe(false);
  expect(result.ok ? "" : result.error.message).toContain("container-restarted");
});
