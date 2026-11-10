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

function lines(count: number, tag = "l"): string {
  return Array.from({ length: count }, (_, index) => `${tag}${index} some line of text\n`).join("");
}

function write(dir: string, path: string, content: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

type Change = (dir: string) => void;

const MOVES: readonly (readonly [string, Record<string, string>, Change])[] = [
  [
    "a move with a large edit",
    { a: lines(10) },
    (dir) => {
      run(dir, ["mv", "a", "b"]);
      write(dir, "b", lines(3) + lines(7, "z"));
    },
  ],
  [
    "a move with an edit at exactly half the content",
    { a: lines(4) },
    (dir) => {
      run(dir, ["mv", "a", "b"]);
      write(dir, "b", lines(2) + lines(2, "z"));
    },
  ],
  [
    "a tiny file moved with an edit",
    { a: "abc\n" },
    (dir) => {
      run(dir, ["mv", "a", "b"]);
      write(dir, "b", "abd\n");
    },
  ],
  [
    "two identical files moved",
    { a1: lines(5), a2: lines(5) },
    (dir) => {
      run(dir, ["mv", "a1", "b1"]);
      run(dir, ["mv", "a2", "b2"]);
    },
  ],
  [
    "two identical files moved crosswise",
    { a1: lines(5), a2: lines(5) },
    (dir) => {
      run(dir, ["mv", "a1", "b2"]);
      run(dir, ["mv", "a2", "b1"]);
    },
  ],
  [
    "identical files in directories moved to new names",
    { "d/x": lines(5), "e/x": lines(5) },
    (dir) => {
      run(dir, ["mv", "d/x", "f1"]);
      run(dir, ["mv", "e/x", "f2"]);
    },
  ],
  [
    "a moved directory",
    { "d/a": lines(10), "d/b": lines(10, "q") },
    (dir) => {
      run(dir, ["mv", "d", "e"]);
    },
  ],
  [
    "an empty file moved",
    { a: "" },
    (dir) => {
      run(dir, ["mv", "a", "b"]);
    },
  ],
  [
    "one file moved and a copy added",
    { a: lines(10) },
    (dir) => {
      run(dir, ["mv", "a", "b"]);
      write(dir, "c", lines(10));
    },
  ],
  [
    "a moved file with CRLF line ends converted",
    { a: "one\r\ntwo\r\nthree\r\nfour\r\n" },
    (dir) => {
      run(dir, ["mv", "a", "b"]);
      write(dir, "b", "one\ntwo\nthree\nfour\n");
    },
  ],
  [
    "a binary file moved with an edit",
    { a: `\0abc${lines(5)}` },
    (dir) => {
      run(dir, ["mv", "a", "b"]);
      write(dir, "b", `\0abd${lines(5)}`);
    },
  ],
];

function repo(files: Record<string, string>, change: Change): string {
  const dir = mkdtempSync(join(tmpdir(), "git-rename-"));
  directories.push(dir);
  run(dir, ["init", "-q", "-b", "main", "."]);

  for (const [path, content] of Object.entries(files)) write(dir, path, content);

  run(dir, ["add", "-A"]);
  run(dir, ["commit", "-q", "-m", "first"]);
  change(dir);
  run(dir, ["add", "-A"]);

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

for (const [name, files, change] of MOVES)
  test(`git status shows ${name} the way real git does`, async () => {
    const dir = repo(files, change);

    for (const flags of [["-s"], ["--porcelain"], [], ["-sb"]])
      expect(await isolate(dir, flags)).toBe(run(dir, ["status", ...flags]).stdout);
  });
