import { expect, test, vi } from "vitest";
import { everythingLogged } from "../../log-capture.js";
import { MAX_FILE_BYTES } from "../../../src/workspace/project/protocol.js";
import { encode, makeTarget } from "./target-helpers.js";

test("appending to a file too large to read still adds the bytes", async () => {
  const { provider, target } = makeTarget();
  provider.addFile("/workspace/big.log", new Uint8Array(MAX_FILE_BYTES + 1));

  const appended = await target.writeFile("/big.log", encode("x"), "append");
  const info = await target.lstat("/big.log");

  expect(appended.ok).toBe(true);
  expect(info).toMatchObject({ ok: true, value: { size: MAX_FILE_BYTES + 2 } });
});

test("writeFile returns a provider failure when creating a missing parent throws", async () => {
  const { provider, target } = makeTarget();
  provider.mkdirSync = () => {
    throw Object.assign(new Error("read-only"), { code: "EROFS" });
  };

  await expect(target.writeFile("/missing/file.txt", encode("x"), "overwrite")).resolves.toEqual({
    ok: false,
    error: { code: "permission-denied" },
  });
});

test("lstat returns a provider failure when symlink metadata cannot be read", async () => {
  const { provider, target } = makeTarget();
  provider.addSymlink("/workspace/link", "target");
  provider.readlinkSync = () => {
    throw new Error("metadata unavailable");
  };

  await expect(target.lstat("/link")).resolves.toEqual({
    ok: false,
    error: { code: "backend-unavailable" },
  });
});

test("an unmapped provider code is redacted like the error it came with", async () => {
  const token = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";
  const { provider, target } = makeTarget();
  provider.lstatSync = () => {
    throw Object.assign(new Error(token), { code: token });
  };

  vi.spyOn(console, "error").mockImplementation(() => {});

  await expect(target.lstat("/anything")).resolves.toEqual({
    ok: false,
    error: { code: "backend-unavailable", path: "/anything" },
  });
  expect(everythingLogged()).not.toContain(token);
  expect(everythingLogged()).toContain("[redacted]");
});

test("a thrown non-error value is backend-unavailable", async () => {
  const { provider, target } = makeTarget();
  provider.lstatSync = () => {
    throw JSON.parse('"boom"');
  };

  await expect(target.lstat("/anything")).resolves.toEqual({
    ok: false,
    error: { code: "backend-unavailable", path: "/anything" },
  });
});
