import { expect, test } from "vitest";
import { bothRun, pair } from "./git-pair.js";

const empty = (message: string): readonly string[] => [
  "commit",
  "-q",
  "--allow-empty",
  "-m",
  message,
];

const MERGED: readonly (readonly string[])[] = [
  empty("base"),
  ["checkout", "-q", "-b", "side"],
  empty("side-1"),
  empty("side-2"),
  ["checkout", "-q", "main"],
  empty("main-1"),
  empty("main-2"),
  ["merge", "-q", "--no-ff", "-m", "merge side", "side"],
  empty("after"),
];

const FORMS: readonly (readonly string[])[] = [
  ["log", "--oneline"],
  ["log", "--format=%s"],
  ["log"],
  ["log", "-n", "3", "--oneline"],
  ["log", "-n", "2", "--oneline"],
  ["log", "--oneline", "side"],
];

test.each(FORMS)(
  "git %s %s %s %s orders same-second commits after a merge like git",
  async (...args) => {
    const both = pair({}, MERGED);
    const ran = await bothRun(both, [...args]);

    expect(ran.isolate).toEqual(ran.real);
  },
);
