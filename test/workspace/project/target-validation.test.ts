import { expect, test, vi } from "vitest";
import type { StartExecWire } from "../../../src/workspace/project/protocol.js";
import { makeTarget } from "./target-helpers.js";

test.each<readonly [string, string]>([
  ["a backslash", "a\\b"],
  ["a path that needs normalization", "/a/../b"],
])("lstat/readFile reject a malformed path: %s", async (_label, path) => {
  const { provider, target } = makeTarget();

  for (const call of [target.lstat(path), target.readFile(path)]) {
    await expect(call).resolves.toEqual({ ok: false, error: { code: "invalid-request" } });
  }

  expect(provider.calls).toEqual([]);
});

test("startExec limits concurrent operations and releases a settled slot", async () => {
  const { execBackend, target } = makeTarget();

  const started = await Promise.all(
    Array.from({ length: 8 }, () => target.startExec({ command: "x" })),
  );

  expect(started.every((result) => result.ok)).toBe(true);

  await expect(target.startExec({ command: "x" })).resolves.toEqual({
    ok: false,
    error: { code: "too-many-operations" },
  });
  expect(execBackend.requests).toHaveLength(8);

  const first = started[0]!;

  if (!first.ok) throw new Error("expected startExec to succeed");
  await first.value.events.cancel();

  await expect(target.startExec({ command: "x" })).resolves.toMatchObject({ ok: true });
  expect(execBackend.requests).toHaveLength(9);
});

test.each<readonly [string, StartExecWire]>([
  ["a NaN timeout", { command: "true", timeoutMs: Number.NaN }],
])("startExec rejects %s and starts no timer", async (_label, input) => {
  vi.useFakeTimers();

  try {
    const { execBackend, target } = makeTarget();
    await expect(target.startExec(input)).resolves.toEqual({
      ok: false,
      error: { code: "invalid-request" },
    });
    expect(execBackend.requests).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("kill rejects a malformed operation id", async () => {
  const { target } = makeTarget();

  await expect(target.kill("not-a-uuid:0")).resolves.toEqual({
    ok: false,
    error: { code: "invalid-request" },
  });
});
