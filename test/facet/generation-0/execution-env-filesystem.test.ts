import { expect, test } from "vitest";
import { encode, makeFacetExecutionEnv } from "./execution-env-target.js";

const NOT_SUPPORTED = { ok: false, error: { code: "not_supported" } };

test('joinPath resolves local FileError("not_supported")', async () => {
  const { env } = makeFacetExecutionEnv();
  await expect(env.joinPath(["a"])).resolves.toMatchObject(NOT_SUPPORTED);
});

test('readTextLines resolves local FileError("not_supported")', async () => {
  const { env } = makeFacetExecutionEnv();
  await expect(env.readTextLines("/workspace/a.txt")).resolves.toMatchObject(NOT_SUPPORTED);
});

test('renameFile resolves local FileError("not_supported")', async () => {
  const { env } = makeFacetExecutionEnv();
  await expect(env.renameFile("/workspace/a.txt", "/workspace/b.txt")).resolves.toMatchObject(
    NOT_SUPPORTED,
  );
});

test('listDir resolves local FileError("not_supported")', async () => {
  const { env } = makeFacetExecutionEnv();
  await expect(env.listDir("/workspace")).resolves.toMatchObject(NOT_SUPPORTED);
});

test('createDir resolves local FileError("not_supported")', async () => {
  const { env } = makeFacetExecutionEnv();
  await expect(env.createDir("/workspace/a")).resolves.toMatchObject(NOT_SUPPORTED);
});

test('remove resolves local FileError("not_supported")', async () => {
  const { env } = makeFacetExecutionEnv();
  await expect(env.remove("/workspace/a.txt")).resolves.toMatchObject(NOT_SUPPORTED);
});

test('createTempDir resolves local FileError("not_supported")', async () => {
  const { env } = makeFacetExecutionEnv();
  await expect(env.createTempDir()).resolves.toMatchObject(NOT_SUPPORTED);
});

test("cleanup always resolves", async () => {
  const { env } = makeFacetExecutionEnv();
  await expect(env.cleanup()).resolves.toBeUndefined();
});

test("enumerates all 18 ExecutionEnv methods without throwing, including every failure path", async () => {
  const { env } = makeFacetExecutionEnv();

  const calls: Array<Promise<unknown>> = [
    env.absolutePath("missing.txt"),
    env.joinPath(["a"]),
    env.readTextFile("/workspace/missing.txt"),
    env.readTextLines("/workspace/missing.txt"),
    env.readBinaryFile("/workspace/missing.txt"),
    env.writeFile("/workspace/nested/missing/dir/f.txt", "x"),
    env.appendFile("/workspace/nested/missing/dir/f.txt", "x"),
    env.renameFile("/workspace/a.txt", "/workspace/b.txt"),
    env.fileInfo("/workspace/missing.txt"),
    env.listDir("/workspace/missing"),
    env.canonicalPath("/workspace/missing.txt"),
    env.exists("/workspace/missing.txt"),
    env.createDir("/workspace/a"),
    env.remove("/workspace/a.txt"),
    env.createTempDir(),
    env.createTempFile(),
    env.cleanup(),
    // A tiny timeout keeps this deterministic: the target's own timer settles the operation
    // without a test needing to script an exec backend response for this generic sweep.
    env.exec("true", { timeout: 0.001 }),
  ];

  const settled = await Promise.allSettled(calls);
  expect(settled.every((entry) => entry.status === "fulfilled")).toBe(true);
});

test("cwd is a synchronous, local absolute path", () => {
  const { env } = makeFacetExecutionEnv();
  expect(env.cwd).toBe("/workspace");
});

test("arbitrary bytes round-trip exactly through writeFile/readBinaryFile", async () => {
  const { env } = makeFacetExecutionEnv();
  const bytes = new Uint8Array([0x00, 0xff, 0xc3, 0x28]);
  await expect(env.writeFile("/workspace/weird.bin", bytes)).resolves.toEqual({
    ok: true,
    value: undefined,
  });
  const read = await env.readBinaryFile("/workspace/weird.bin");
  expect(read.ok).toBe(true);

  if (read.ok) expect(Array.from(read.value)).toEqual([0x00, 0xff, 0xc3, 0x28]);
});

test("readTextFile decodes with replacement, but readBinaryFile preserves the raw bytes", async () => {
  const { env } = makeFacetExecutionEnv();
  const invalidUtf8 = new Uint8Array([0x00, 0xff, 0xc3, 0x28]);
  await env.writeFile("/workspace/weird.bin", invalidUtf8);

  const text = await env.readTextFile("/workspace/weird.bin");
  expect(text.ok).toBe(true);

  if (text.ok) {
    expect(text.value.includes("\uFFFD")).toBe(true);
    expect(text.value.codePointAt(0)).toBe(0);
  }

  const binary = await env.readBinaryFile("/workspace/weird.bin");
  expect(binary.ok).toBe(true);

  if (binary.ok) expect(Array.from(binary.value)).toEqual([0x00, 0xff, 0xc3, 0x28]);
});

test("multibyte text round-trips and reports a byte-counted size, not a character count", async () => {
  const { env } = makeFacetExecutionEnv();
  // "héllo" is 5 UTF-16 code units but 6 UTF-8 bytes.
  await env.writeFile("/workspace/greeting.txt", "héllo");

  const text = await env.readTextFile("/workspace/greeting.txt");
  expect(text).toEqual({ ok: true, value: "héllo" });

  const info = await env.fileInfo("/workspace/greeting.txt");
  expect(info.ok).toBe(true);

  if (info.ok) expect(info.value.size).toBe(6);
});

test("appendFile appends without reading the file first", async () => {
  const { env } = makeFacetExecutionEnv();
  await env.writeFile("/workspace/log.txt", "a");
  await env.appendFile("/workspace/log.txt", "b");
  await env.appendFile("/workspace/log.txt", "c");
  await expect(env.readTextFile("/workspace/log.txt")).resolves.toEqual({ ok: true, value: "abc" });
});

test("fileInfo strips the target's nested canonicalPath and returns Pi's own FileInfo shape", async () => {
  const { provider, env } = makeFacetExecutionEnv();
  provider.now = 1234;
  await env.writeFile("/workspace/dir/file.txt", "hi");

  const info = await env.fileInfo("/workspace/dir/file.txt");
  expect(info).toEqual({
    ok: true,
    value: {
      name: "file.txt",
      path: "/workspace/dir/file.txt",
      kind: "file",
      size: 2,
      mtimeMs: 1234,
    },
  });
});

test("absolutePath resolves a relative path against cwd", async () => {
  const { env } = makeFacetExecutionEnv();
  await expect(env.absolutePath("src/index.ts")).resolves.toEqual({
    ok: true,
    value: "/workspace/src/index.ts",
  });
});

test("absolutePath is purely lexical: it normalizes . and .. without touching the filesystem", async () => {
  const { env } = makeFacetExecutionEnv();
  await expect(env.absolutePath("/workspace/a/../b/./c")).resolves.toEqual({
    ok: true,
    value: "/workspace/b/c",
  });
  await expect(env.absolutePath("a/../../etc/passwd")).resolves.toMatchObject({
    ok: false,
    error: { code: "invalid" },
  });
});

test("readBinaryFile on a missing file is not_found", async () => {
  const { env } = makeFacetExecutionEnv();
  await expect(env.readBinaryFile("/workspace/nope.txt")).resolves.toMatchObject({
    ok: false,
    error: { code: "not_found" },
  });
});

test("exists is false only for a missing path; other failures stay FileErrors", async () => {
  const { env } = makeFacetExecutionEnv();
  await expect(env.exists("/workspace/nope.txt")).resolves.toEqual({ ok: true, value: false });
  await env.writeFile("/workspace/there.txt", "hi");
  await expect(env.exists("/workspace/there.txt")).resolves.toEqual({ ok: true, value: true });
  await expect(env.exists("/../escape.txt")).resolves.toMatchObject({
    ok: false,
    error: { code: "invalid" },
  });
});

function withSymlinks() {
  const context = makeFacetExecutionEnv();
  context.provider.addDirectory("/workspace/dir");
  context.provider.addFile("/workspace/dir/file.txt", encode("hello"));
  context.provider.addSymlink("/workspace/rel-link", "dir/file.txt");
  context.provider.addSymlink("/workspace/dangling", "dir/missing.txt");
  context.provider.addSymlink("/workspace/escape", "../outside");
  context.provider.addSymlink("/workspace/loop-a", "loop-b");
  context.provider.addSymlink("/workspace/loop-b", "loop-a");

  return context;
}

test("an in-root symlink reads through to its target, but absolutePath never resolves it", async () => {
  const { env } = withSymlinks();
  await expect(env.absolutePath("/workspace/rel-link")).resolves.toEqual({
    ok: true,
    value: "/workspace/rel-link",
  });
  await expect(env.readTextFile("/workspace/rel-link")).resolves.toEqual({
    ok: true,
    value: "hello",
  });
});

test("canonicalPath follows an in-root symlink to its real path", async () => {
  const { env } = withSymlinks();
  await expect(env.canonicalPath("/workspace/rel-link")).resolves.toEqual({
    ok: true,
    value: "/workspace/dir/file.txt",
  });
});

test("a dangling symlink is not_found through canonicalPath", async () => {
  const { env } = withSymlinks();
  await expect(env.canonicalPath("/workspace/dangling")).resolves.toMatchObject({
    ok: false,
    error: { code: "not_found" },
  });
});

test("an escaping symlink is a local FileError, not a crash", async () => {
  const { env } = withSymlinks();
  await expect(env.canonicalPath("/workspace/escape")).resolves.toMatchObject({
    ok: false,
    error: { code: "invalid" },
  });
});

test("a symlink loop is a local FileError", async () => {
  const { env } = withSymlinks();
  await expect(env.canonicalPath("/workspace/loop-a")).resolves.toMatchObject({
    ok: false,
    error: { code: "invalid" },
  });
  await expect(env.readTextFile("/workspace/loop-a")).resolves.toMatchObject({
    ok: false,
    error: { code: "invalid" },
  });
});

test("the returned environment has no enumerable project target and no build/fetch/container capability", () => {
  const { env } = makeFacetExecutionEnv();
  const keys = Object.keys(env).toSorted();
  expect(keys).toEqual(
    [
      "absolutePath",
      "appendFile",
      "canonicalPath",
      "cleanup",
      "createDir",
      "createTempDir",
      "createTempFile",
      "cwd",
      "exec",
      "exists",
      "fileInfo",
      "joinPath",
      "listDir",
      "readBinaryFile",
      "readTextFile",
      "readTextLines",
      "remove",
      "renameFile",
      "writeFile",
    ].toSorted(),
  );
  expect(keys).not.toContain("projectTarget");
  expect(keys).not.toContain("build");
  expect(keys).not.toContain("fetch");
  expect(keys).not.toContain("container");
  expect(keys).not.toContain("computer");
});
