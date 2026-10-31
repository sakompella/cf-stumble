import { expect, test, vi } from "vitest";
import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import type { StartExecWire } from "../../../src/workspace/project/protocol.js";
import { makeTarget } from "./target-helpers.js";

test("reflection exposes exactly six methods and no forbidden backing capability", () => {
  const { target } = makeTarget();

  expect(Object.getOwnPropertyNames(ProjectRpcTarget.prototype).toSorted()).toEqual(
    [
      "constructor",
      "endTurn",
      "kill",
      "listFiles",
      "lstat",
      "readFile",
      "startExec",
      "writeFile",
    ].toSorted(),
  );
  expect(Object.keys(target)).toEqual([]);

  for (const forbidden of [
    "build",
    "fetch",
    "exec",
    "runCommand",
    "provider",
    "workspace",
    "container",
  ]) {
    expect(Reflect.has(target, forbidden)).toBe(false);
  }
});

test.each<readonly [string, string]>([
  ["a backslash", "a\\b"],
  ["a path that needs normalization", "/a/../b"],
])("lstat/readFile/listFiles reject a malformed path: %s", async (_label, path) => {
  const { provider, target } = makeTarget();

  for (const call of [target.lstat(path), target.readFile(path), target.listFiles(path)]) {
    await expect(call).resolves.toEqual({ ok: false, error: { code: "invalid-request" } });
  }

  expect(provider.calls).toEqual([]);
});

test("startExec limits commands by UTF-8 byte length", async () => {
  const { execBackend, target } = makeTarget();
  const command = "é".repeat(Math.floor(65_536 / 2) + 1);

  await expect(target.startExec({ command })).resolves.toEqual({
    ok: false,
    error: { code: "invalid-request" },
  });
  expect(execBackend.requests).toEqual([]);
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
  ["an empty command", { command: "" }],
  ["a negative timeout", { command: "true", timeoutMs: -5 }],
  ["a NaN timeout", { command: "true", timeoutMs: Number.NaN }],
  ["a zero timeout", { command: "true", timeoutMs: 0 }],
  ["a relative cwd", { command: "true", cwd: "relative" }],
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

test("startExec rejects a field the protocol does not define", async () => {
  const { execBackend, target } = makeTarget();
  const input = { command: "true", extra: true };

  await expect(target.startExec(input)).resolves.toEqual({
    ok: false,
    error: { code: "invalid-request" },
  });
  expect(execBackend.requests).toEqual([]);
});

test.each(["", "not-a-uuid:0"])(
  "kill rejects a malformed operation id (%j)",
  async (operationId) => {
    const { target } = makeTarget();
    await expect(target.kill(operationId)).resolves.toEqual({
      ok: false,
      error: { code: "invalid-request" },
    });
  },
);
