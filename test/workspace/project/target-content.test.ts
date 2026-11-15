import { expect, test } from "vitest";
import { encode, makeTarget } from "./target-helpers.js";

test("a symlink's size is the byte length of its target, not the string length", async () => {
  const { provider, target } = makeTarget();
  const targetText = "café-target";
  provider.addSymlink("/workspace/link", targetText);

  const info = await target.lstat("/link");
  expect(info.ok).toBe(true);

  if (info.ok) {
    expect(info.value.kind).toBe("symlink");
    expect(info.value.size).toBe(new TextEncoder().encode(targetText).length);
    expect(info.value.size).not.toBe(targetText.length);
  }
});

test("lstat reports kind, size, mtimeMs, and the addressed path", async () => {
  const { provider, target } = makeTarget();
  provider.addDirectory("/workspace/dir");
  provider.now = 1234;
  provider.addFile("/workspace/dir/file.txt", encode("hi"));

  const info = await target.lstat("/dir/file.txt");
  expect(info.ok).toBe(true);

  if (info.ok) {
    expect(info.value).toMatchObject({
      name: "file.txt",
      path: "/dir/file.txt",
      kind: "file",
      size: 2,
      mtimeMs: 1234,
    });
    expect(info.value.canonicalPath).toEqual({ ok: true, value: "/dir/file.txt" });
  }
});
