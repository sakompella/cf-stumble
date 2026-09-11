import { expect, test } from "vitest";
import { encode, makeTarget } from "./target-helpers.js";

function withSymlinks() {
  const context = makeTarget();
  context.provider.addDirectory("/workspace/dir");
  context.provider.addFile("/workspace/dir/file.txt", encode("hello"));
  context.provider.addDirectory("/workspace/dir2");
  context.provider.addFile("/workspace/dir2/a.txt", encode("a"));
  context.provider.addSymlink("/workspace/rel-link", "dir/file.txt");
  context.provider.addSymlink("/workspace/abs-link", "/workspace/dir/file.txt");
  context.provider.addSymlink("/workspace/dir-link", "dir2");
  context.provider.addSymlink("/workspace/dangling", "dir/missing.txt");
  context.provider.addSymlink("/workspace/escape-rel", "../outside");
  context.provider.addSymlink("/workspace/escape-abs", "/etc/passwd");
  context.provider.addSymlink("/workspace/loop-a", "loop-b");
  context.provider.addSymlink("/workspace/loop-b", "loop-a");

  return context;
}

test("relative and absolute in-root symlinks read through to their target", async () => {
  const { target } = withSymlinks();

  for (const path of ["/rel-link", "/abs-link"]) {
    const result = await target.readFile(path);
    expect(result.ok).toBe(true);

    if (result.ok) expect(new TextDecoder().decode(result.value)).toBe("hello");
  }
});

test("writing through a symlink writes the real target, not the link", async () => {
  const { provider, target } = withSymlinks();
  await target.writeFile("/rel-link", encode("changed"), "overwrite");

  expect(provider.nodes.get("/workspace/dir/file.txt")).toMatchObject({ type: "file" });
  const real = await target.readFile("/dir/file.txt");
  expect(real.ok).toBe(true);

  if (real.ok) expect(new TextDecoder().decode(real.value)).toBe("changed");
});

test("listFiles through a symlinked directory lists the real directory", async () => {
  const { target } = withSymlinks();
  const listing = await target.listFiles("/dir-link");
  expect(listing.ok).toBe(true);

  if (listing.ok) expect(listing.value.map((entry) => entry.name)).toEqual(["a.txt"]);
});

test("lstat's canonicalPath resolves the full symlink chain", async () => {
  const { target } = withSymlinks();
  const info = await target.lstat("/rel-link");
  expect(info.ok).toBe(true);

  if (info.ok) {
    expect(info.value.kind).toBe("symlink");
    expect(info.value.canonicalPath).toEqual({ ok: true, value: "/dir/file.txt" });
  }
});

test("startExec resolves cwd through a symlink to its real directory", async () => {
  const { execBackend, target } = withSymlinks();
  const started = await target.startExec({ command: "true", cwd: "/dir-link" });
  expect(started.ok).toBe(true);
  expect(execBackend.requests).toEqual([
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- `expect.any(Number)` is vitest's untyped asymmetric matcher.
    { command: "true", cwd: "/workspace/dir2", timeoutMs: expect.any(Number) },
  ]);
});

test("a dangling symlink target is not-found", async () => {
  const { target } = withSymlinks();
  await expect(target.readFile("/dangling")).resolves.toEqual({
    ok: false,
    error: { code: "not-found", path: "/dangling" },
  });
  const info = await target.lstat("/dangling");
  expect(info.ok).toBe(true);

  if (info.ok) {
    expect(info.value.kind).toBe("symlink");
    expect(info.value.canonicalPath).toEqual({
      ok: false,
      error: { code: "not-found", path: "/dangling" },
    });
  }
});

test("an escaping symlink, relative or absolute, is path-outside-root", async () => {
  const { target } = withSymlinks();
  const relative = await target.readFile("/escape-rel");
  expect(relative.ok ? undefined : relative.error.code).toBe("path-outside-root");
  const absolute = await target.readFile("/escape-abs");
  expect(absolute.ok ? undefined : absolute.error.code).toBe("path-outside-root");
});

test("a symlink loop is symlink-loop", async () => {
  const { target } = withSymlinks();
  await expect(target.readFile("/loop-a")).resolves.toEqual({
    ok: false,
    error: { code: "symlink-loop", path: "/loop-a" },
  });
});

test("this target never calls provider.realpath", () => {
  const { provider } = withSymlinks();
  expect("realpath" in provider).toBe(false);
  expect(provider.calls.some((call) => call.startsWith("realpath"))).toBe(false);
});
