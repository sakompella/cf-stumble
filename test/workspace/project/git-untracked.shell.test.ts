import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Workspace } from "@cloudflare/computer";
import { createGitClient } from "@cloudflare/computer/git";
import { afterEach, expect, test } from "vitest";
import { statusCommand } from "../../../src/workspace/project/git-status-command.js";

const directories: string[] = [];

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const workspace = new Workspace({
  storage: {
    sql: { exec: () => ({ toArray: () => [] }) },
    transactionSync: (closure) => closure(),
  },
});

const client = createGitClient({ adapter: () => Promise.resolve({ promises: fsp }) })({
  ws: { provider: () => workspace.provider() },
});

const GIT = ["-c", "user.name=T", "-c", "user.email=t@e"];

function run(dir: string, args: readonly string[]) {
  return spawnSync("git", ["-C", dir, ...GIT, ...args], { encoding: "utf8" });
}

const LAYOUTS: readonly (readonly [string, readonly string[]])[] = [
  ["an untracked directory", ["d/x"]],
  ["a nested untracked directory", ["d/e/x"]],
  ["two untracked directories and a file", ["d/x", "d/y", "f/z", "g"]],
  ["an untracked directory inside a tracked one", ["tracked/new/x", "tracked/more/y"]],
  ["an untracked file inside a tracked directory", ["tracked/new"]],
  ["an untracked directory deep inside a tracked one", ["tracked/a/b/c"]],
];

function repo(untracked: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "git-untracked-"));
  directories.push(dir);
  run(dir, ["init", "-q", "-b", "main", "."]);
  mkdirSync(join(dir, "tracked"));
  writeFileSync(join(dir, "tracked", "keep"), "k\n");
  run(dir, ["add", "-A"]);
  run(dir, ["commit", "-q", "-m", "first"]);

  for (const path of untracked) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), "u\n");
  }

  return dir;
}

async function isolate(dir: string, flags: readonly string[]): Promise<string> {
  const result = await statusCommand(
    client,
    () => Promise.reject(new Error("fell back to the cli")),
    { argv: ["status", ...flags], cwd: dir },
    { dir, prefix: "" },
    (path) => fsp.readFile(path),
  );

  return result.stdout;
}

test.each(LAYOUTS)("git status lists %s the way real git does", async (_name, untracked) => {
  const dir = repo(untracked);

  for (const flags of [[], ["-s"], ["--porcelain"]])
    expect(await isolate(dir, flags)).toBe(run(dir, ["status", ...flags]).stdout);
});
