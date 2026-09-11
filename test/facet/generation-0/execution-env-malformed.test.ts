import { expect, test } from "vitest";
import { execViaProjectTarget } from "../../../src/facet/generation-0/execution-env-exec.js";
import { createFacetExecutionEnv } from "../../../src/facet/generation-0/execution-env.js";
import {
  asExecTarget,
  asProjectTarget,
  readableFrom,
  rejectingReadable,
} from "./malformed-target-helpers.js";

/**
 * Adversarial targets a real `ProjectRpcTarget` never produces: a malformed envelope, a rejected
 * RPC call, a stream that rejects or ends without a terminal event, and an unexplained kill. These
 * exercise the defensive parsing this adapter must apply at the boundary regardless of how well
 * behaved the actual target is, per the spec's "malformed target envelopes/events" requirement.
 *
 * `execution-env-byte-framing.test.ts` covers the same defensive parsing at the byte level: how
 * `startExec`'s `ReadableStream<Uint8Array>` decodes when a frame is split, concatenated, or
 * truncated at an arbitrary physical chunk boundary.
 */

test("a malformed startExec envelope resolves ExecutionError('unknown')", async () => {
  const target = {
    startExec: () => Promise.resolve({ nonsense: true }),
    kill: () => Promise.resolve(),
  };

  const result = await execViaProjectTarget("/workspace", asExecTarget(target), "x");
  expect(result).toMatchObject({ ok: false, error: { code: "unknown" } });
});

test("a rejected startExec RPC call resolves ExecutionError('unknown')", async () => {
  // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Test double: simulating an arbitrary RPC rejection value.
  const target = {
    startExec: () => Promise.reject(new Error("rpc down")),
    kill: () => Promise.resolve(),
  };

  const result = await execViaProjectTarget("/workspace", asExecTarget(target), "x");
  expect(result).toMatchObject({ ok: false, error: { code: "unknown" } });
});

test("a malformed exec event resolves ExecutionError('unknown')", async () => {
  const events = readableFrom([{ kind: "not-a-real-event" }]);

  const target = {
    startExec: () => Promise.resolve({ ok: true, value: { operationId: "op-1", events } }),
    kill: () => Promise.resolve(),
  };

  const result = await execViaProjectTarget("/workspace", asExecTarget(target), "x");
  expect(result).toMatchObject({ ok: false, error: { code: "unknown" } });
});

test("the stream ending without a terminal event resolves ExecutionError('unknown')", async () => {
  const events = readableFrom([{ kind: "stdout", data: "partial" }]);

  const target = {
    startExec: () => Promise.resolve({ ok: true, value: { operationId: "op-1", events } }),
    kill: () => Promise.resolve(),
  };

  const result = await execViaProjectTarget("/workspace", asExecTarget(target), "x");
  expect(result).toMatchObject({ ok: false, error: { code: "unknown" } });
});

test("a rejecting exec event stream resolves ExecutionError('unknown')", async () => {
  const target = {
    startExec: () =>
      Promise.resolve({ ok: true, value: { operationId: "op-1", events: rejectingReadable() } }),
    kill: () => Promise.resolve(),
  };

  const result = await execViaProjectTarget("/workspace", asExecTarget(target), "x");
  expect(result).toMatchObject({ ok: false, error: { code: "unknown" } });
});

test("an unexplained 'killed' event, with no abort requested, resolves ExecutionError('unknown')", async () => {
  const events = readableFrom([{ kind: "terminal", outcome: "killed" }]);

  const target = {
    startExec: () => Promise.resolve({ ok: true, value: { operationId: "op-1", events } }),
    kill: () => Promise.resolve(),
  };

  const result = await execViaProjectTarget("/workspace", asExecTarget(target), "x");
  expect(result).toMatchObject({ ok: false, error: { code: "unknown" } });
});

test("a non-empty env override is rejected before startExec is ever called", async () => {
  let started = false;

  const target = {
    startExec: () => {
      started = true;

      return Promise.resolve({
        ok: true,
        value: { operationId: "op-1", events: readableFrom([]) },
      });
    },
    kill: () => Promise.resolve(),
  };

  const result = await execViaProjectTarget("/workspace", asExecTarget(target), "x", {
    env: { FOO: "bar" },
  });

  expect(result).toMatchObject({ ok: false, error: { code: "unknown" } });
  expect(started).toBe(false);
});

test("inheritEnv: false is rejected before startExec is ever called", async () => {
  let started = false;

  const target = {
    startExec: () => {
      started = true;

      return Promise.resolve({
        ok: true,
        value: { operationId: "op-1", events: readableFrom([]) },
      });
    },
    kill: () => Promise.resolve(),
  };

  const result = await execViaProjectTarget("/workspace", asExecTarget(target), "x", {
    inheritEnv: false,
  });

  expect(result).toMatchObject({ ok: false, error: { code: "unknown" } });
  expect(started).toBe(false);
});

test("an already-aborted signal resolves ExecutionError('aborted') without calling startExec", async () => {
  let started = false;

  const target = {
    startExec: () => {
      started = true;

      return Promise.resolve({
        ok: true,
        value: { operationId: "op-1", events: readableFrom([]) },
      });
    },
    kill: () => Promise.resolve(),
  };

  const controller = new AbortController();
  controller.abort();

  const result = await execViaProjectTarget("/workspace", asExecTarget(target), "x", {
    abortSignal: controller.signal,
  });

  expect(result).toMatchObject({ ok: false, error: { code: "aborted" } });
  expect(started).toBe(false);
});

test("a throwing onStdout callback kills the operation and resolves ExecutionError('callback_error')", async () => {
  const events = readableFrom([
    { kind: "stdout", data: "hi\n" },
    { kind: "terminal", outcome: "exited", exitCode: 0 },
  ]);

  let killCalls = 0;

  const target = {
    startExec: () => Promise.resolve({ ok: true, value: { operationId: "op-1", events } }),
    kill: () => {
      killCalls += 1;

      return Promise.resolve();
    },
  };

  const result = await execViaProjectTarget("/workspace", asExecTarget(target), "x", {
    onStdout: () => {
      throw new Error("callback exploded");
    },
  });

  expect(result).toMatchObject({ ok: false, error: { code: "callback_error" } });
  expect(killCalls).toBe(1);
});

test("startExec failing outright is a spawn_error, and never rejects", async () => {
  const target = {
    startExec: () => Promise.resolve({ ok: false, error: { code: "not-directory", path: "/bad" } }),
    kill: () => Promise.resolve(),
  };

  const result = await execViaProjectTarget("/workspace", asExecTarget(target), "x");
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- `expect.objectContaining` is vitest's untyped asymmetric matcher.
  expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: "spawn_error" }) });
});

test("a malformed lstat envelope from the filesystem side resolves a local FileError, not a throw", async () => {
  const target = {
    lstat: () => Promise.resolve("not an envelope at all"),
    readFile: () => Promise.resolve({ ok: false, error: { code: "not-found" } }),
    writeFile: () => Promise.resolve({ ok: false, error: { code: "not-found" } }),
    listFiles: () => Promise.resolve({ ok: true, value: [] }),
    startExec: () => Promise.resolve({ ok: false, error: { code: "backend-unavailable" } }),
    kill: () => Promise.resolve(),
  };

  const env = createFacetExecutionEnv({
    cwd: "/workspace",
    projectTarget: asProjectTarget(target),
  });

  await expect(env.fileInfo("anything.txt")).resolves.toMatchObject({
    ok: false,
    error: { code: "unknown" },
  });
});
