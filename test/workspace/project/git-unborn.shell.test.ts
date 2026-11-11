import { expect, test } from "vitest";
import { bothRun, pair, realGit, state, write } from "./git-pair.js";

const FORMS: readonly (readonly string[])[] = [
  ["reset", "a.txt"],
  ["reset"],
  ["reset", "--hard"],
  ["reset", "--mixed"],
  ["reset", "HEAD"],
  ["reset", "--", "a.txt"],
  ["reset", "--", "nope"],
  ["reset", "nope"],
  ["reset", "u.txt"],
  ["reset", "*.txt"],
  ["checkout", "HEAD", "--", "a.txt"],
  ["checkout", "--", "a.txt"],
  ["checkout", "-b", "x"],
  ["checkout", "main"],
  ["checkout", "HEAD"],
  ["switch", "main"],
  ["switch", "-c", "y"],
  ["restore", "--staged", "a.txt"],
  ["restore", "--source=HEAD", "a.txt"],
  ["restore", "--source=HEAD", "--staged", "a.txt"],
  ["show"],
  ["show", "HEAD"],
  ["merge", "x"],
  ["stash"],
  ["stash", "push"],
  ["stash", "list"],
  ["diff", "HEAD"],
  ["rev-parse", "HEAD"],
  ["tag", "t"],
];

test.each(FORMS)("git %s %s %s %s on an unborn branch matches real git", async (...args) => {
  const both = pair({});

  for (const dir of [both.real, both.isolate]) {
    write(dir, "a.txt", "a\n");
    write(dir, "u.txt", "u\n");
    realGit(dir, ["add", "a.txt"]);
  }

  const ran = await bothRun(both, [...args]);

  expect(ran.isolate).toEqual(ran.real);
  expect(state(both.isolate)).toEqual(state(both.real));
});
