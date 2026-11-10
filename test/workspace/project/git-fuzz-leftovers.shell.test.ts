import { expect, test } from "vitest";
import { bothRun, pair } from "./git-pair.js";

const FILES = { "a.txt": "a\n", "ünï.txt": "u\n", 'q"t.txt': "q\n", "d/e.txt": "e\n" };

const COMMITTED: readonly (readonly string[])[] = [
  ["add", "a.txt"],
  ["commit", "-q", "-m", "first"],
];

const FORMS: readonly (readonly string[])[] = [
  ["status"],
  ["status", "-s"],
  ["commit", "-m", "x"],
  ["commit", "-m", ""],
  ["add", "-u", "d/e/"],
  ["add", "nope/"],
  ["mv", "nope.txt", "d/"],
  ["mv", "nope", "d/e.txt/"],
  ["checkout", "nonexistent-branch"],
  ["checkout", "origin/nope"],
];

for (const [name, setup] of [
  ["unborn", []],
  ["committed", COMMITTED],
] as const) {
  test.each(FORMS)(`git %s %s %s %s matches real git on ${name} HEAD`, async (...args) => {
    const both = pair(FILES, setup);
    const ran = await bothRun(both, [...args]);

    expect(ran.isolate).toEqual(ran.real);
  });
}

test("commit --allow-empty is left to the container", async () => {
  const both = pair(FILES);
  const ran = await bothRun(both, ["commit", "--allow-empty", "-m", "x"]);

  expect(ran.isolate.exitCode).toBe(129);
  expect(ran.isolate.stdout).toBe("");
});

test("checkout - is left to the container", async () => {
  const both = pair(FILES, COMMITTED);
  const ran = await bothRun(both, ["checkout", "-"]);

  expect(ran.isolate.exitCode).toBe(129);
});
