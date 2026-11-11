import { expect, test } from "vitest";
import { bothRun, pair, state } from "./git-pair.js";

const FILES = { "a.txt": "a\n", "d/u.txt": "u\n", "e/t.txt": "t\n", "f/g/h.txt": "h\n" };

const COMMITTED: readonly (readonly string[])[] = [
  ["add", "a.txt", "e/t.txt"],
  ["commit", "-q", "-m", "first"],
];

const FORMS: readonly (readonly string[])[] = [
  ["add", "-u", "d/"],
  ["add", "-u", "d"],
  ["add", "-u", "d/u.txt"],
  ["add", "-u", "f/"],
  ["add", "-u", "f/g"],
  ["add", "-u", "nope/"],
  ["add", "-u", "nope"],
  ["add", "-u", "e/"],
  ["add", "-u", "e/", "d/"],
  ["add", "-u", "d/", "f/"],
  ["add", "-u", "nope", "d/"],
  ["add", "-u", "d/", "nope"],
  ["add", "-u", "--", "d/"],
  ["add", "-u", "d/*"],
  ["add", "-u", "*.nope"],
  ["add", "d/", "nope/"],
];

test.each(FORMS)("git %s %s %s %s matches real git for untracked directories", async (...args) => {
  const both = pair(FILES, COMMITTED);
  const ran = await bothRun(both, [...args]);

  expect(ran.isolate).toEqual(ran.real);
  expect(state(both.isolate)).toEqual(state(both.real));
});
