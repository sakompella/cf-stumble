import { rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { bothRun, pair, realGit, state, write } from "./git-pair.js";

const FILES = { "a.txt": "a\n", "b.txt": "b\n", "d/c.txt": "c\n", "gone.txt": "g\n" };

const FORMS: readonly (readonly string[])[] = [
  ["commit", "-m", "x", "--", "nope"],
  ["commit", "-m", "x", "--", "new.txt"],
  ["commit", "-m", "x", "--", "a.txt", "zzz"],
  ["commit", "-m", "x", "--", "a.txt"],
  ["commit", "-m", "x", "a.txt"],
  ["commit", "-m", "x", "--", "b.txt"],
  ["commit", "-m", "x", "--", "d"],
  ["commit", "-m", "x", "--", "*.txt"],
  ["commit", "-m", "x", "--", "gone.txt"],
  ["commit", "-q", "-m", "x", "--", "a.txt", "b.txt"],
];

function repository() {
  const both = pair(FILES, [
    ["add", "-A"],
    ["commit", "-q", "-m", "first"],
  ]);

  for (const dir of [both.real, both.isolate]) {
    write(dir, "a.txt", "changed\n");
    write(dir, "d/c.txt", "changed\n");
    write(dir, "new.txt", "new\n");
    rmSync(join(dir, "gone.txt"));
  }

  return both;
}

test.each(FORMS)("git %s %s %s %s %s %s matches real git", async (...args) => {
  const both = repository();
  const ran = await bothRun(both, [...args]);

  expect(ran.isolate).toEqual(ran.real);
  expect(state(both.isolate)).toEqual(state(both.real));
});

test("git commit -- path on an unborn branch names the unknown path", async () => {
  const both = pair({ "a.txt": "a\n" });
  const ran = await bothRun(both, ["commit", "-m", "x", "--", "a.txt"]);

  expect(ran.isolate).toEqual(ran.real);
});

test("git commit -- path leaves to git when other paths are staged", async () => {
  const both = repository();

  for (const dir of [both.real, both.isolate]) realGit(dir, ["add", "b.txt", "new.txt"]);

  const ran = await bothRun(both, ["commit", "-m", "x", "--", "a.txt"]);

  expect(ran.isolate.exitCode).toBe(129);
});
