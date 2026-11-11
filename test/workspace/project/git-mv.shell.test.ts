import { expect, test } from "vitest";
import { bothRun, pair, state, write } from "./git-pair.js";

const FORMS: readonly (readonly string[])[] = [
  ["mv", "a.txt", "a.txt"],
  ["mv", "a.txt", "sub/s.txt"],
  ["mv", "a.txt", "sub/"],
  ["mv", "a.txt", "nodir/"],
  ["mv", "a.txt", "nodir/x.txt"],
  ["mv", "a.txt", "b.txt", "c.txt"],
  ["mv", "sub", "a.txt"],
  ["mv", "sub", "sub/x"],
  ["mv", "sub", "sub2"],
  ["mv", "sub/", "sub2/"],
  ["mv", "sub", "."],
  ["mv", "sub", "d"],
  ["mv", "d", "new/d"],
  ["mv", "d/", "sub"],
  ["mv", "a.txt", "../x"],
  ["mv", "./a.txt", "b.txt"],
  ["mv", "a.txt", "b2.txt"],
  ["mv", "a.txt", "sub/c.txt"],
  ["mv", "a.txt", "sub"],
  ["mv", "b.txt", "z.txt"],
  ["mv", "u.txt", "x"],
  ["mv", "nope", "x"],
  ["mv", "sub/s.txt", "."],
  ["mv", "sub/s.txt", "d", "a.txt", "nope"],
];

test.each(FORMS)("git %s %s %s %s matches real git", async (...args) => {
  const both = pair({ "a.txt": "a\n", "sub/s.txt": "s\n", "sub/t.txt": "t\n", "d/e.txt": "e\n" }, [
    ["add", "-A"],
    ["commit", "-q", "-m", "first"],
  ]);

  for (const dir of [both.real, both.isolate]) {
    write(dir, "b.txt", "b\n");
    write(dir, "u.txt", "u\n");
  }

  const ran = await bothRun(both, ["add", "b.txt"]);

  expect(ran.isolate).toEqual(ran.real);

  const moved = await bothRun(both, [...args]);

  expect(moved.isolate).toEqual(moved.real);
  expect(state(both.isolate)).toEqual(state(both.real));
});
