import { afterEach, expect, test } from "vitest";
import { put, realGit, realStatus, remove, scratch } from "./git-status-fixtures.js";
import { isolateStatus } from "./git-status-isolate.js";

const directories: string[] = [];

afterEach(() => {
  for (const dir of directories.splice(0)) remove(dir);
});

function repository(tracked: readonly string[]): string {
  const dir = scratch();
  directories.push(dir);
  realGit(dir, ["init", "-q", "-b", "main"]);

  for (const path of tracked) put(dir, path, `${path}\n`);

  realGit(dir, ["add", "."]);
  realGit(dir, ["commit", "-q", "-m", "first", "--allow-empty"]);

  return dir;
}

async function expectSame(dir: string, prefix: string, flags: readonly string[]): Promise<string> {
  const expected = realStatus(dir, prefix, flags);

  expect(await isolateStatus(dir, prefix, flags)).toBe(expected);

  return expected;
}

test("git status --porcelain prints paths from the repository root even inside a subdirectory", async () => {
  const dir = repository(["tracked"]);
  put(dir, "d/e/b", "new\n");
  put(dir, "d/e/c", "new\n");
  realGit(dir, ["add", "d/e/c"]);

  expect(await expectSame(dir, "d/e", ["--porcelain"])).toBe("A  d/e/c\n?? d/e/b\n");
  expect(await expectSame(dir, "d/e", ["--porcelain", "--long"])).toContain("\tnew file:   c\n");
  expect(await expectSame(dir, "d/e", ["--porcelain", "-s"])).toBe("A  c\n?? b\n");
});

test("git status from a subdirectory shortens a path that shares directories with it", async () => {
  const dir = repository(["d/x", "d/e/y", "f/z"]);
  put(dir, "d/x", "changed\n");
  put(dir, "d/e/y", "changed\n");
  put(dir, "d/w", "new\n");
  put(dir, "n/m", "new\n");

  expect(await expectSame(dir, "d/e", ["-s"])).toBe(" M y\n M ../x\n?? ../w\n?? ../../n/\n");

  await expectSame(dir, "d/e", []);
});

test("git status shows an untracked directory above the working directory as ../", async () => {
  const dir = repository([]);
  put(dir, "d/e/b", "new\n");

  expect(await expectSame(dir, "d/e", ["-s"])).toBe("?? ../\n");
  await expectSame(dir, "d/e", []);
});
