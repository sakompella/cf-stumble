import { expect, test } from "vitest";
import { execViaProjectTarget } from "../../../src/facet/generation-0/execution-env-exec.js";
import { asExecTarget, readableFromChunks } from "./malformed-target-helpers.js";

/**
 * The wire itself is bytes: `startExec`'s real contract is `ReadableStream<Uint8Array>` of
 * newline-delimited UTF-8 JSON frames, since that is the only shape a Workers RPC hop can carry
 * across an isolate boundary. These tests build that `ReadableStream<Uint8Array>` directly so they
 * can control exactly how the bytes are cut: a frame split across two reads, several frames
 * concatenated into one read, a multibyte UTF-8 sequence split mid-character, invalid JSON, and a
 * truncated final frame with no closing newline.
 */

test("a single JSON frame split across two physical byte chunks still decodes as one event", async () => {
  const encoder = new TextEncoder();
  const frame = `${JSON.stringify({ kind: "stdout", data: "hi\n" })}\n`;
  const splitAt = Math.floor(frame.length / 2);
  const chunks = [encoder.encode(frame.slice(0, splitAt)), encoder.encode(frame.slice(splitAt))];

  const terminal = encoder.encode(
    `${JSON.stringify({ kind: "terminal", outcome: "exited", exitCode: 0 })}\n`,
  );

  const events = readableFromChunks([...chunks, terminal]);

  const target = {
    startExec: () => Promise.resolve({ ok: true, value: { operationId: "op-1", events } }),
    kill: () => Promise.resolve(),
  };

  const seen: string[] = [];

  const result = await execViaProjectTarget("/workspace", asExecTarget(target), "x", {
    onStdout: (chunk) => {
      seen.push(chunk);
    },
  });

  expect(seen).toEqual(["hi\n"]);
  expect(result).toEqual({ ok: true, value: { stdout: "hi\n", stderr: "", exitCode: 0 } });
});

test("two frames concatenated into a single physical byte chunk both decode in order", async () => {
  const encoder = new TextEncoder();
  const stdoutFrame = `${JSON.stringify({ kind: "stdout", data: "a" })}\n`;
  const terminalFrame = `${JSON.stringify({ kind: "terminal", outcome: "exited", exitCode: 0 })}\n`;
  const events = readableFromChunks([encoder.encode(stdoutFrame + terminalFrame)]);

  const target = {
    startExec: () => Promise.resolve({ ok: true, value: { operationId: "op-1", events } }),
    kill: () => Promise.resolve(),
  };

  const seen: string[] = [];

  const result = await execViaProjectTarget("/workspace", asExecTarget(target), "x", {
    onStdout: (chunk) => {
      seen.push(chunk);
    },
  });

  expect(seen).toEqual(["a"]);
  expect(result).toEqual({ ok: true, value: { stdout: "a", stderr: "", exitCode: 0 } });
});

test("a multibyte UTF-8 character split across two physical byte chunks decodes intact", async () => {
  const encoder = new TextEncoder();
  const frame = encoder.encode(`${JSON.stringify({ kind: "stdout", data: "caf\u00E9\n" })}\n`);
  const splitAt = frame.length - 2;

  const terminal = encoder.encode(
    `${JSON.stringify({ kind: "terminal", outcome: "exited", exitCode: 0 })}\n`,
  );

  const events = readableFromChunks([frame.slice(0, splitAt), frame.slice(splitAt), terminal]);

  const target = {
    startExec: () => Promise.resolve({ ok: true, value: { operationId: "op-1", events } }),
    kill: () => Promise.resolve(),
  };

  const seen: string[] = [];

  const result = await execViaProjectTarget("/workspace", asExecTarget(target), "x", {
    onStdout: (chunk) => {
      seen.push(chunk);
    },
  });

  expect(seen).toEqual(["caf\u00E9\n"]);
  expect(result).toEqual({ ok: true, value: { stdout: "caf\u00E9\n", stderr: "", exitCode: 0 } });
});

test("a byte chunk that is not valid JSON resolves ExecutionError('unknown')", async () => {
  const events = readableFromChunks([new TextEncoder().encode("not json at all\n")]);

  const target = {
    startExec: () => Promise.resolve({ ok: true, value: { operationId: "op-1", events } }),
    kill: () => Promise.resolve(),
  };

  const result = await execViaProjectTarget("/workspace", asExecTarget(target), "x");
  expect(result).toMatchObject({ ok: false, error: { code: "unknown" } });
});

test("a truncated final frame with no closing newline resolves ExecutionError('unknown')", async () => {
  const partial = JSON.stringify({ kind: "stdout", data: "partial" }).slice(0, -3);
  const events = readableFromChunks([new TextEncoder().encode(partial)]);

  const target = {
    startExec: () => Promise.resolve({ ok: true, value: { operationId: "op-1", events } }),
    kill: () => Promise.resolve(),
  };

  const result = await execViaProjectTarget("/workspace", asExecTarget(target), "x");
  expect(result).toMatchObject({ ok: false, error: { code: "unknown" } });
});
