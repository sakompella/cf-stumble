import { afterEach, expect, test, vi } from "vitest";
import { capturedEvents, named } from "./log-capture.js";
import { newRequestId, timedWorkspaceRpc } from "../src/diagnostics.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("logs a waiting event every 30 seconds and clears it when the RPC settles", async () => {
  vi.useFakeTimers();
  const events = capturedEvents();
  let resolve: (() => void) | undefined;

  const pending = new Promise<void>((done) => {
    resolve = done;
  });

  const rpc = timedWorkspaceRpc(
    { method: "project" },
    () => pending,
    () => ({ outcome: "ok" }),
  );

  await vi.advanceTimersByTimeAsync(30_000);
  expect(named(events(), "workspace.rpc-waiting")).toEqual([
    expect.objectContaining({ level: "warn", method: "project", elapsedMs: 30_000 }),
  ]);

  resolve?.();
  await rpc;
  await vi.advanceTimersByTimeAsync(60_000);

  expect(named(events(), "workspace.rpc-waiting")).toHaveLength(1);
});

test("a waiting event carries the request id and bound, and a late settlement adds no terminal event", async () => {
  vi.useFakeTimers();
  const events = capturedEvents();
  const requestId = newRequestId();
  let resolve: (() => void) | undefined;

  const pending = new Promise<void>((done) => {
    resolve = done;
  });

  const rpc = timedWorkspaceRpc(
    { requestId, method: "credential" },
    () => pending,
    () => ({ outcome: "ok" }),
    45_000,
  );

  const settled = expect(rpc).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(named(events(), "workspace.rpc-waiting")).toEqual([
    expect.objectContaining({ requestId, method: "credential", timeoutMs: 45_000 }),
  ]);

  await vi.advanceTimersByTimeAsync(15_000);
  await settled;
  resolve?.();
  await vi.advanceTimersByTimeAsync(60_000);

  expect(named(events(), "workspace.rpc")).toEqual([
    expect.objectContaining({ level: "error", requestId, outcome: "threw", timeout: true }),
  ]);
  expect(named(events(), "workspace.rpc-waiting")).toHaveLength(1);
});
