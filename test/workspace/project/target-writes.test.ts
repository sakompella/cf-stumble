import { afterEach, expect, test, vi } from "vitest";
import { everythingLogged } from "../../log-capture.js";
import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
} from "./fakes.js";
import { MAX_FILE_BYTES } from "../../../src/workspace/project/protocol.js";
import { encode, makeTarget } from "./target-helpers.js";

test("concurrent appends land after the existing content, each once, in call order", async () => {
  const { provider, target } = makeTarget();
  provider.addFile("/workspace/log.txt", encode("head\n"));
  const lines = Array.from({ length: 100 }, (_unused, index) => `line-${index}\n`);

  const results = await Promise.all(
    lines.map((line) => target.writeFile("/log.txt", encode(line), "append")),
  );

  const read = await target.readFile("/log.txt");

  expect(results.every((result) => result.ok)).toBe(true);
  expect(read).toEqual({ ok: true, value: encode(`head\n${lines.join("")}`) });
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

test("appending to a file too large to read still adds the bytes", async () => {
  const { provider, target } = makeTarget();
  provider.addFile("/workspace/big.log", new Uint8Array(MAX_FILE_BYTES + 1));

  const appended = await target.writeFile("/big.log", encode("x"), "append");
  const info = await target.lstat("/big.log");

  expect(appended.ok).toBe(true);
  expect(info).toMatchObject({ ok: true, value: { size: MAX_FILE_BYTES + 2 } });
});

function throwingProvider(code: string): FakeProjectFilesystemProvider {
  const provider = new FakeProjectFilesystemProvider();
  provider.lstatSync = () => {
    throw Object.assign(new Error(code), { code });
  };

  return provider;
}

test("writeFile returns a provider failure when creating a missing parent throws", async () => {
  const { provider, target } = makeTarget();
  provider.mkdirSync = () => {
    throw Object.assign(new Error("read-only"), { code: "EROFS" });
  };

  expect(() => target.writeFile("/missing/file.txt", encode("x"), "overwrite")).not.toThrow();
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

  expect(() => target.lstat("/link")).not.toThrow();
  await expect(target.lstat("/link")).resolves.toEqual({
    ok: false,
    error: { code: "backend-unavailable" },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("an unmapped provider code is redacted like the error it came with", async () => {
  const token = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";

  const target = new ProjectRpcTarget(
    throwingProvider(token),
    new FakeProjectTransactions(),
    new FakeExecBackend(),
  );

  vi.spyOn(console, "error").mockImplementation(() => {});

  await expect(target.lstat("/anything")).resolves.toEqual({
    ok: false,
    error: { code: "backend-unavailable", path: "/anything" },
  });
  expect(everythingLogged()).not.toContain(token);
  expect(everythingLogged()).toContain("[redacted]");
});

test("a thrown non-error value is backend-unavailable", async () => {
  const provider = new FakeProjectFilesystemProvider();
  provider.lstatSync = () => {
    throw JSON.parse('"boom"');
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
