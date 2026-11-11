import { expect, test } from "vitest";
import { bothRun, pair, realGit, state, write } from "./git-pair.js";

const SETUP: readonly (readonly string[])[] = [
  ["add", "-A"],
  ["commit", "-q", "-m", "first"],
];

const FORMS: readonly (readonly string[])[] = [
  ["checkout", "HEAD", "--", "missing.txt"],
  ["checkout", "HEAD", "--", "UPPER.TXT"],
  ["checkout", "HEAD", "--", "a.txt"],
  ["checkout", "HEAD", "--", "a.txt", "missing.txt"],
  ["checkout", "HEAD", "--", "d"],
  ["checkout", "HEAD", "--", "d/none"],
  ["checkout", "main", "--", "nope"],
  ["checkout", "HEAD", "--", "."],
  ["checkout", "HEAD", "--", "d/x.txt", "a.txt"],
];

test.each(FORMS)("git %s %s %s %s %s matches real git", async (...args) => {
  const both = pair({ "a.txt": "a\n", "d/x.txt": "x\n" }, SETUP);

  for (const dir of [both.real, both.isolate]) write(dir, "a.txt", "changed\n");

  const ran = await bothRun(both, [...args]);

  expect(ran.isolate).toEqual(ran.real);
  expect(state(both.isolate)).toEqual(state(both.real));
});

test("git checkout HEAD -- a staged file matches real git", async () => {
  const both = pair({ "a.txt": "a\n" }, SETUP);

  for (const dir of [both.real, both.isolate]) {
    write(dir, "a.txt", "staged\n");
    realGit(dir, ["add", "a.txt"]);
    write(dir, "a.txt", "worktree\n");
  }

  const ran = await bothRun(both, ["checkout", "HEAD", "--", "a.txt"]);

  expect(ran.isolate).toEqual(ran.real);
  expect(state(both.isolate)).toEqual(state(both.real));
});
