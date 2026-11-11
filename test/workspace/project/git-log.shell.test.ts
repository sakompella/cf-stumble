import { expect, test } from "vitest";
import { bothRun, pair, realGit, state, write } from "./git-pair.js";

const FILES = { "a.txt": "a\n", "b.txt": "b\n", "d/c.txt": "c\n" };

const FORMS: readonly (readonly string[])[] = [
  ["log"],
  ["log", "--oneline"],
  ["log", "--oneline", "--", "d"],
  ["log", "--oneline", "d"],
  ["log", "--oneline", "--", "a.txt"],
  ["log", "--oneline", "--", "*.txt"],
  ["log", "--oneline", "--", "nope"],
  ["log", "--oneline", "nope"],
  ["log", "--oneline", "--", "."],
  ["log", "--oneline", "HEAD", "--", "d"],
  ["log", "--oneline", "HEAD~1", "--", "d"],
  ["log", "-n", "1", "--", "d"],
  ["log", "-1"],
  ["log", "-n", "x"],
  ["log", "-n", "0"],
  ["log", "--", "d"],
  ["log", "--format=%H|%h|%s|%b|%an|%ae|%ad|%cn|%ce|%cd|%%|%n|%T|%t|%P|%p"],
  ["log", "--pretty=format:%s"],
  ["log", "--pretty=tformat:%s"],
  ["log", "--format=%s"],
  ["log", "--pretty=oneline"],
  ["log", "bad", "--", "a.txt"],
];

function history() {
  const both = pair(FILES, [
    ["add", "-A"],
    ["commit", "-q", "-m", "first"],
  ]);

  for (const dir of [both.real, both.isolate]) {
    write(dir, "d/c.txt", "c2\n");
    realGit(dir, ["commit", "-qam", "two\n\nbody here\n\nmore"]);
    write(dir, "a.txt", "a2\n");
    realGit(dir, ["commit", "-qam", "three"]);
  }

  return both;
}

test.each(FORMS)("git %s %s %s %s matches real git", async (...args) => {
  const both = history();
  const ran = await bothRun(both, [...args]);

  expect(ran.isolate).toEqual(ran.real);
});

test("git log on an unborn branch says there are no commits, with or without a path", async () => {
  const both = pair({});

  for (const args of [["log"], ["log", "--", "d"], ["log", "--oneline"]]) {
    const ran = await bothRun(both, args);

    expect(ran.isolate).toEqual(ran.real);
  }
});

test("git log -- directory lists a merge only when it differs from every parent", async () => {
  const both = history();

  for (const dir of [both.real, both.isolate]) {
    realGit(dir, ["checkout", "-q", "-b", "side", "HEAD~1"]);
    write(dir, "e.txt", "e\n");
    realGit(dir, ["add", "e.txt"]);
    realGit(dir, ["commit", "-q", "-m", "side"]);
    realGit(dir, ["checkout", "-q", "main"]);
    realGit(dir, ["merge", "-q", "--no-ff", "-m", "merge", "side"]);
  }

  for (const args of [
    ["log", "--oneline", "--", "d"],
    ["log", "--oneline", "--", "e.txt"],
  ]) {
    const ran = await bothRun(both, args);

    expect(ran.isolate).toEqual(ran.real);
  }

  expect(state(both.isolate)).toEqual(state(both.real));
});
