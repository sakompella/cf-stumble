import { afterEach, expect, test, vi } from "vitest";
import { capturedEvents, named } from "./log-capture.js";
import { timedWorkspaceRpc } from "../src/diagnostics.js";

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
