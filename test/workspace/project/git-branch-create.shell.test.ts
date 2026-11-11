import { expect, test } from "vitest";
import { bothRun, pair, realGit, state, write } from "./git-pair.js";

const FORMS: readonly (readonly string[])[] = [
  ["branch", "x", "HEAD~1"],
  ["branch", "x", "HEAD"],
  ["branch", "x", "nope"],
  ["branch", "x", "main~1"],
  ["branch", "x", "side"],
  ["branch", "feature/x", "main"],
  ["branch", "-f", "x", "HEAD~1"],
  ["branch", "-f", "main", "side"],
  ["branch", "main"],
  ["branch", "bad name"],
  ["branch", "a..b"],
  ["branch", "a.lock"],
  ["branch", "HEAD"],
];

test.each(FORMS)("git %s %s %s %s matches real git on one commit", async (...args) => {
  const both = pair({ "a.txt": "a\n" }, [
    ["add", "-A"],
    ["commit", "-q", "-m", "first"],
  ]);

  const ran = await bothRun(both, [...args]);

  expect(ran.isolate).toEqual(ran.real);
  expect(state(both.isolate)).toEqual(state(both.real));
});

test.each(FORMS)("git %s %s %s %s matches real git on two commits", async (...args) => {
  const both = pair({ "a.txt": "a\n" }, [
    ["add", "-A"],
    ["commit", "-q", "-m", "first"],
  ]);

  for (const dir of [both.real, both.isolate]) {
    write(dir, "a.txt", "b\n");
    realGit(dir, ["commit", "-qam", "two"]);
    realGit(dir, ["branch", "side", "HEAD~1"]);
  }

  const ran = await bothRun(both, [...args]);

  expect(ran.isolate).toEqual(ran.real);
  expect(state(both.isolate)).toEqual(state(both.real));
});

test("git branch x on an unborn branch names the current branch", async () => {
  const both = pair({});
  const ran = await bothRun(both, ["branch", "x"]);

  expect(ran.isolate).toEqual(ran.real);
});
