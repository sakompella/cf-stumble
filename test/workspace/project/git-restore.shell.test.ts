import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Workspace } from "@cloudflare/computer";
import { createGitClient } from "@cloudflare/computer/git";
import { afterEach, expect, test } from "vitest";
import { restoreCommand } from "../../../src/workspace/project/git-index-commands.js";

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

interface RepoPair {
  readonly expected: string;
  readonly actual: string;
}

function repoPair(): RepoPair {
  const root = mkdtempSync(join(tmpdir(), "git-restore-"));
  directories.push(root);
  const expected = join(root, "expected");
  const actual = join(root, "actual");

  for (const dir of [expected, actual]) {
    mkdirSync(dir);
    run(dir, ["init", "-q", "-b", "main", "."]);

    for (const [step, files] of [
      ["first", { "f.txt": "one\n" }],
      ["second", { "f.txt": "one\ntwo\n", "d/g.txt": "deep\n" }],
    ] as const) {
      for (const [name, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, name)), { recursive: true });
        writeFileSync(join(dir, name), content);
      }

      run(dir, ["add", "-A"]);
      run(dir, ["commit", "-q", "-m", step]);
    }
  }

  return { expected, actual };
}

function expectSameState({ expected, actual }: RepoPair): void {
  for (const name of ["f.txt", "d/g.txt"]) {
    const read = (dir: string): string | undefined => {
      try {
        return readFileSync(join(dir, name), "utf8");
      } catch {
        return undefined;
      }
    };

    expect(read(actual)).toBe(read(expected));
  }

  expect(run(actual, ["status", "-s"]).stdout).toBe(run(expected, ["status", "-s"]).stdout);
}

function restore(dir: string, args: readonly string[]) {
  return restoreCommand(
    client,
    { argv: ["restore", ...args], cwd: dir },
    { dir, prefix: "" },
    (path) => fsp.readFile(path),
  );
}

test("git restore writes the index version of a modified tracked file", async () => {
  const pair = repoPair();

  for (const dir of [pair.expected, pair.actual]) writeFileSync(join(dir, "f.txt"), "junk\n");

  run(pair.expected, ["restore", "f.txt"]);

  const restored = await restore(pair.actual, ["f.txt"]);

  expect(restored.exitCode).toBe(0);
  expectSameState(pair);
});

test("git restore recreates a deleted tracked file", async () => {
  const pair = repoPair();

  for (const dir of [pair.expected, pair.actual]) rmSync(join(dir, "d", "g.txt"));

  run(pair.expected, ["restore", "d/g.txt"]);

  const restored = await restore(pair.actual, ["d/g.txt"]);

  expect(restored.exitCode).toBe(0);
  expectSameState(pair);
});

test("git restore with a directory pathspec restores its files", async () => {
  const pair = repoPair();

  for (const dir of [pair.expected, pair.actual]) rmSync(join(dir, "d", "g.txt"));

  run(pair.expected, ["restore", "d"]);

  const restored = await restore(pair.actual, ["d"]);

  expect(restored.exitCode).toBe(0);
  expectSameState(pair);
});

test("git restore . restores every tracked path", async () => {
  const pair = repoPair();

  for (const dir of [pair.expected, pair.actual]) {
    writeFileSync(join(dir, "f.txt"), "junk\n");
    rmSync(join(dir, "d", "g.txt"));
  }

  run(pair.expected, ["restore", "."]);

  const restored = await restore(pair.actual, ["."]);

  expect(restored.exitCode).toBe(0);
  expectSameState(pair);
});

test("git restore --source writes the source version and keeps the index", async () => {
  const pair = repoPair();

  run(pair.expected, ["restore", "--source", "HEAD~1", "f.txt"]);

  const restored = await restore(pair.actual, ["--source", "HEAD~1", "f.txt"]);

  expect(restored.exitCode).toBe(0);
  expectSameState(pair);
});

test("git restore --staged --worktree resets both the index and the working tree", async () => {
  const pair = repoPair();

  for (const dir of [pair.expected, pair.actual]) {
    writeFileSync(join(dir, "f.txt"), "staged\n");
    run(dir, ["add", "f.txt"]);
    writeFileSync(join(dir, "f.txt"), "staged\nworktree\n");
  }

  run(pair.expected, ["restore", "--staged", "--worktree", "f.txt"]);

  const restored = await restore(pair.actual, ["--staged", "--worktree", "f.txt"]);

  expect(restored.exitCode).toBe(0);
  expectSameState(pair);
});

test("git restore of a path with staged changes refuses instead of losing them", async () => {
  const pair = repoPair();

  for (const dir of [pair.expected, pair.actual]) {
    writeFileSync(join(dir, "f.txt"), "staged\n");
    run(dir, ["add", "f.txt"]);
    writeFileSync(join(dir, "f.txt"), "staged\nworktree\n");
  }

  const restored = await restore(pair.actual, ["f.txt"]);

  expect(restored.exitCode).toBe(128);
  expect(restored.stderr).toContain("has staged changes");
  expect(run(pair.actual, ["status", "-s"]).stdout).toBe("MM f.txt\n");
});

test("git restore of an unknown path fails with the error of real git", async () => {
  const pair = repoPair();

  const expectedRun = run(pair.expected, ["restore", "nope.txt"]);

  const restored = await restore(pair.actual, ["nope.txt"]);

  expect(restored.stderr).toBe(expectedRun.stderr);
  expect(restored.exitCode).toBe(expectedRun.status);
});
