import { expect, test } from "vitest";
import { bothRun, pair, realGit, state, write } from "./git-pair.js";

const FORMS: readonly (readonly string[])[] = [
  ["checkout", "--detach"],
  ["checkout", "--detach", "HEAD~1"],
  ["checkout", "--detach", "main"],
  ["checkout", "--detach", "nope"],
  ["switch", "--detach"],
  ["switch", "--detach", "HEAD~1"],
  ["checkout", "-B", "x"],
  ["checkout", "-B", "main"],
  ["checkout", "-B", "x", "HEAD~1"],
  ["checkout", "-B", "y", "side"],
  ["checkout", "-B", "x", "nope"],
  ["checkout", "-b", "x", "HEAD~1"],
  ["checkout", "-b", "main"],
];

test.each(FORMS)("git %s %s %s %s matches real git", async (...args) => {
  const both = pair({ "a.txt": "a\n" }, [
    ["add", "-A"],
    ["commit", "-q", "-m", "first"],
  ]);

  for (const dir of [both.real, both.isolate]) {
    write(dir, "a.txt", "2\n");
    realGit(dir, ["commit", "-qam", "two"]);
    realGit(dir, ["branch", "side", "HEAD~1"]);
  }

  const ran = await bothRun(both, [...args]);

  expect(ran.isolate).toEqual(ran.real);
  expect(state(both.isolate)).toEqual(state(both.real));
});
