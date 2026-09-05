import { expect, test } from "vitest";
import { encode, makeTarget } from "./target-helpers.js";

test("arbitrary bytes round-trip exactly", async () => {
  const { target } = makeTarget();
  const bytes = new Uint8Array([0x00, 0xff, 0xc3, 0x28]);

  await expect(target.writeFile("/weird.bin", bytes, "overwrite")).resolves.toEqual({
    ok: true,
    value: null,
  });
  const read = await target.readFile("/weird.bin");
  expect(read.ok).toBe(true);
  if (read.ok) expect(Array.from(read.value)).toEqual([0x00, 0xff, 0xc3, 0x28]);
});

test("multibyte file content reports a byte size, not a character count", async () => {
  const { target } = makeTarget();
  // "héllo" is 5 UTF-16 code units but 6 UTF-8 bytes.
  const content = "héllo";
  await target.writeFile("/greeting.txt", encode(content), "overwrite");

  const info = await target.lstat("/greeting.txt");
  expect(info.ok).toBe(true);
  if (info.ok) expect(info.value.size).toBe(6);
});

test("a symlink's size is the byte length of its target, not the string length", async () => {
  const { provider, target } = makeTarget();
  // "café-target" is 11 characters but 12 UTF-8 bytes.
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
