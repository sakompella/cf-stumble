import { expect, test, vi } from "vitest";
import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import { encode, makeTarget } from "./target-helpers.js";

test("reflection exposes exactly six methods and no forbidden backing capability", () => {
  const { target } = makeTarget();

  expect(Object.getOwnPropertyNames(ProjectRpcTarget.prototype).toSorted()).toEqual(
    ["constructor", "kill", "listFiles", "lstat", "readFile", "startExec", "writeFile"].toSorted(),
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

test.each<readonly [string, unknown]>([
  ["null", null],
  ["a number", 42],
  ["a relative path", "relative/path"],
  ["a backslash", "a\\b"],
  ["a NUL byte", "/a\0b"],
  ["a dot segment", "/a/./b"],
  ["a dot-dot segment", "/a/../b"],
  ["a doubled slash", "/a//b"],
  ["a trailing slash", "/a/"],
])("lstat/readFile/listFiles reject a malformed path: %s", async (_label, path) => {
  const { provider, target } = makeTarget();
  for (const call of [target.lstat(path), target.readFile(path), target.listFiles(path)]) {
    await expect(call).resolves.toEqual({ ok: false, error: { code: "invalid-request" } });
  }
  expect(provider.calls).toEqual([]);
});

test.each<readonly [string, unknown, unknown]>([
  ["non-Uint8Array bytes", "not bytes", "overwrite"],
  ["an unknown mode", encode("x"), "bogus-mode"],
  ["a null mode", encode("x"), null],
])("writeFile rejects %s", async (_label, bytes, mode) => {
  const { provider, target } = makeTarget();
  await expect(target.writeFile("/f.txt", bytes, mode)).resolves.toEqual({
    ok: false,
    error: { code: "invalid-request" },
  });
  expect(provider.calls).toEqual([]);
});

test.each<readonly [string, unknown]>([
  ["null", null],
  ["missing command", {}],
  ["a non-string command", { command: 5 }],
  ["an extra field", { command: "true", extra: true }],
  ["a negative timeout", { command: "true", timeoutMs: -5 }],
  ["a NaN timeout", { command: "true", timeoutMs: Number.NaN }],
  ["a string timeout", { command: "true", timeoutMs: "10" }],
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

test.each<readonly [string, unknown]>([
  ["null", null],
  ["a number", 123],
  ["an empty string", ""],
  ["a plain string", "not-a-uuid:0"],
])("kill rejects a malformed operation id (%s)", async (_label, operationId) => {
  const { target } = makeTarget();
  await expect(target.kill(operationId)).resolves.toEqual({
    ok: false,
    error: { code: "invalid-request" },
  });
});
