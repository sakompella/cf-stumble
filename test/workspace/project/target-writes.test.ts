import { expect, test } from "vitest";
import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
} from "./fakes.js";
import { encode, makeTarget } from "./target-helpers.js";

test("100 concurrent appends preserve every framed payload exactly once", async () => {
  const { target } = makeTarget();
  const lines = Array.from({ length: 100 }, (_unused, index) => `line-${index}`);

  await Promise.all(
    lines.map((line) => target.writeFile("/log.txt", encode(`${line}\n`), "append")),
  );

  const read = await target.readFile("/log.txt");
  expect(read.ok).toBe(true);
  if (read.ok) {
    const written = new TextDecoder().decode(read.value).split("\n").filter(Boolean);
    expect(written.length).toBe(100);
    expect(new Set(written).size).toBe(100);
    expect(new Set(written)).toEqual(new Set(lines));
  }
});

test("concurrent exclusive creates yield exactly one success", async () => {
  const { target } = makeTarget();
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      target.writeFile("/claim.txt", encode("x"), "create-exclusive"),
    ),
  );

  const successes = results.filter((result) => result.ok);
  const conflicts = results.filter(
    (result) => !result.ok && result.error.code === "already-exists",
  );
  expect(successes.length).toBe(1);
  expect(conflicts.length).toBe(19);
});

test("appending never reads the file's existing content first", async () => {
  const { provider, target, transactions } = makeTarget();
  await target.writeFile("/log.txt", encode("first\n"), "append");
  provider.calls.length = 0;

  await target.writeFile("/log.txt", encode("second\n"), "append");

  expect(provider.calls.some((call) => call.startsWith("read:"))).toBe(false);
  expect(transactions.calls).toBeGreaterThanOrEqual(2);
});

function throwingProvider(code: string): FakeProjectFilesystemProvider {
  const provider = new FakeProjectFilesystemProvider();
  provider.lstatSync = () => {
    throw Object.assign(new Error(code), { code });
  };
  return provider;
}

test.each<readonly [string, string]>([
  ["ENOENT", "not-found"],
  ["ENOTDIR", "not-directory"],
  ["EISDIR", "is-directory"],
  ["EACCES", "permission-denied"],
  ["EPERM", "permission-denied"],
  ["EROFS", "permission-denied"],
  ["ELOOP", "symlink-loop"],
  ["EWEIRD", "backend-unavailable"],
])("provider error %s maps to %s", async (rawCode, expected) => {
  const provider = throwingProvider(rawCode);
  const target = new ProjectRpcTarget(
    provider,
    new FakeProjectTransactions(),
    new FakeExecBackend(),
  );
  const result = await target.lstat("/anything");
  expect(result).toEqual({ ok: false, error: { code: expected, path: "/anything" } });
});

test("a thrown non-error value is backend-unavailable", async () => {
  const provider = new FakeProjectFilesystemProvider();
  provider.lstatSync = () => {
    // oxlint-disable-next-line typescript/only-throw-error, eslint/no-throw-literal -- Intentionally exercising a non-Error throw from an untrusted backend.
    throw "boom";
  };
  const target = new ProjectRpcTarget(
    provider,
    new FakeProjectTransactions(),
    new FakeExecBackend(),
  );
  await expect(target.lstat("/anything")).resolves.toEqual({
    ok: false,
    error: { code: "backend-unavailable", path: "/anything" },
  });
});
