import { rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { bothRun, exists, pair, realGit, state, write } from "./git-pair.js";

const COMMITTED = {
  "a.txt": "a\n",
  "b.txt": "b\n",
  "d/c.txt": "c\n",
  "da/x": "x\n",
  ".gitignore": "*.log\n",
};

const FORMS: readonly (readonly string[])[] = [
  ["add", "*.txt"],
  ["add", "-f", "*.txt"],
  ["add", "-f", "*.log"],
  ["add", "*.log"],
  ["add", "d*"],
  ["add", "d?"],
  ["add", "d/*.txt"],
  ["add", "nope"],
  ["add", "*.zzz"],
  ["add", "-u"],
  ["add", "-u", "*.txt"],
  ["add", "-u", "n.txt"],
  ["add", "-u", "d"],
  ["add"],
  ["add", "ig.log"],
  ["add", "-f", "ig.log"],
  ["add", "a.txt"],
  ["add", "c.txt"],
  ["add", "."],
  ["add", "-f", "."],
  ["add", "--", "*.txt"],
  ["add", "d"],
  ["add", "[ab].txt"],
  ["add", "[!a].txt"],
  ["add", "?.txt"],
  ["add", "a.txt", "*.zzz"],
];

const RESTORES: readonly (readonly string[])[] = [
  ["restore", "--staged", "*.txt"],
  ["restore", "--staged", "d/*.txt"],
  ["restore", "--staged", "*.zzz"],
  ["restore", "--staged", "[ab].txt"],
  ["restore", "--staged", "d"],
  ["restore", "--source=HEAD", "--staged", "*.txt"],
];

function repository() {
  const both = pair(COMMITTED, [
    ["add", "-A"],
    ["commit", "-q", "-m", "first"],
  ]);

  for (const dir of [both.real, both.isolate]) {
    write(dir, "a.txt", "changed\n");
    write(dir, "n.txt", "new\n");
    write(dir, "d/n.txt", "new\n");
    write(dir, "ig.log", "ignored\n");
    write(dir, "d/ig.log", "ignored\n");
    rmSync(join(dir, "b.txt"));
  }

  return both;
}

test.each(FORMS)("git %s %s %s matches real git", async (...args) => {
  const both = repository();
  const ran = await bothRun(both, [...args]);

  expect(ran.isolate).toEqual(ran.real);
  expect(state(both.isolate)).toEqual(state(both.real));
});

const WORKTREE_RESTORES: readonly (readonly string[])[] = [
  ["restore", "*.txt"],
  ["restore", "--worktree", "*.txt"],
  ["restore", "d/*"],
  ["restore", "?.txt"],
  ["restore", "*.zzz"],
];

test.each(RESTORES)("git %s %s %s matches real git on staged changes", async (...args) => {
  const both = repository();

  for (const dir of [both.real, both.isolate]) realGit(dir, ["add", "-A"]);

  const ran = await bothRun(both, [...args]);

  expect(ran.isolate).toEqual(ran.real);
  expect(state(both.isolate)).toEqual(state(both.real));
});

test.each(WORKTREE_RESTORES)("git %s %s matches real git on unstaged changes", async (...args) => {
  const both = repository();
  const ran = await bothRun(both, [...args]);

  expect(ran.isolate).toEqual(ran.real);
  expect(state(both.isolate)).toEqual(state(both.real));

  for (const name of ["a.txt", "b.txt"])
    expect(exists(both.isolate, name)).toBe(exists(both.real, name));
});
