import { expect, test } from "vitest";
import { bothRun, pair, realGit, state, write } from "./git-pair.js";

const FORMS: readonly (readonly string[])[] = [
  ["commit", "--amend", "--no-edit"],
  ["commit", "--amend", "-m", "new"],
  ["commit", "--amend", "--no-edit", "-q"],
  ["commit", "--amend", "-a", "--no-edit"],
];

const COMMIT: readonly (readonly string[])[] = [
  ["add", "a.txt"],
  ["commit", "-q", "-m", "first", "--date=2020-03-04T05:06:07+0530"],
];

function authorship(dir: string): string {
  return [
    realGit(dir, ["log", "-1", "--format=%an %ae %aI"]).stdout,
    realGit(dir, ["rev-list", "--count", "HEAD"]).stdout,
  ].join("");
}

test.each(FORMS)("git %s %s %s %s matches real git on a first commit", async (...args) => {
  const both = pair({ "a.txt": "a\n", "b.txt": "b\n" }, COMMIT);

  for (const dir of [both.real, both.isolate]) {
    write(dir, "a.txt", "changed\n");
    realGit(dir, ["add", "a.txt"]);
  }

  const ran = await bothRun(both, [...args]);

  expect(ran.isolate).toEqual(ran.real);
  expect(state(both.isolate)).toEqual(state(both.real));
  expect(authorship(both.isolate)).toEqual(authorship(both.real));
});

test.each(FORMS)("git %s %s %s %s matches real git on a second commit", async (...args) => {
  const both = pair({ "a.txt": "a\n", "b.txt": "b\n" }, COMMIT);

  for (const dir of [both.real, both.isolate]) {
    write(dir, "b.txt", "two\n");
    realGit(dir, ["add", "b.txt"]);
    realGit(dir, ["commit", "-q", "-m", "second"]);
    write(dir, "a.txt", "changed\n");
    realGit(dir, ["add", "a.txt"]);
  }

  const ran = await bothRun(both, [...args]);

  expect(ran.isolate).toEqual(ran.real);
  expect(state(both.isolate)).toEqual(state(both.real));
  expect(authorship(both.isolate)).toEqual(authorship(both.real));
});
