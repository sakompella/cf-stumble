import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { bothRun, pair, realGit, write, type Pair } from "./git-pair.js";

const FORMS: readonly (readonly string[])[] = [
  ["branch", "-D", "main"],
  ["branch", "-d", "main"],
  ["branch", "-d", "side"],
  ["branch", "-d", "unmerged"],
  ["branch", "-D", "unmerged"],
  ["branch", "-d", "nope"],
  ["branch", "-D", "nope"],
  ["branch", "-d"],
  ["branch", "-dq", "side"],
  ["branch", "-d", "side", "unmerged"],
  ["branch", "-d", "unmerged", "side", "nope"],
  ["branch", "--delete", "--force", "unmerged"],
  ["branch", "-d", "-f", "unmerged"],
  ["branch", "-fd", "unmerged"],
];

const COMMIT = [
  ["add", "-A"],
  ["commit", "-q", "-m", "first"],
];

function history(both: Pair): void {
  for (const dir of [both.real, both.isolate]) {
    realGit(dir, ["branch", "side"]);
    write(dir, "a.txt", "b\n");
    realGit(dir, ["commit", "-qam", "two"]);
    realGit(dir, ["checkout", "-q", "-b", "unmerged"]);
    write(dir, "c.txt", "c\n");
    realGit(dir, ["add", "c.txt"]);
    realGit(dir, ["commit", "-qm", "three"]);
    realGit(dir, ["checkout", "-q", "main"]);
  }
}

function refs(dir: string): readonly string[] {
  return [
    ["for-each-ref", "--format=%(refname) %(objectname)"],
    ["config", "--get-regexp", "^branch\\."],
    ["symbolic-ref", "-q", "HEAD"],
  ].map((args) => realGit(dir, args).stdout);
}

test.each(FORMS)("git %s %s %s %s %s matches real git on main", async (...args) => {
  const both = pair({ "a.txt": "a\n" }, COMMIT);

  history(both);

  const ran = await bothRun(both, [...args]);

  expect(ran.isolate).toEqual(ran.real);
  expect(refs(both.isolate)).toEqual(refs(both.real));
});

test.each(FORMS)("git %s %s %s %s %s matches real git on a detached HEAD", async (...args) => {
  const both = pair({ "a.txt": "a\n" }, COMMIT);

  history(both);

  for (const dir of [both.real, both.isolate]) realGit(dir, ["checkout", "-q", "--detach"]);

  const ran = await bothRun(both, [...args]);

  expect(ran.isolate).toEqual(ran.real);
  expect(refs(both.isolate)).toEqual(refs(both.real));
});

test.each(FORMS)("git %s %s %s %s %s matches real git on an unborn branch", async (...args) => {
  const both = pair({});
  const ran = await bothRun(both, [...args]);

  expect(ran.isolate).toEqual(ran.real);
});

function remotePair(): Pair {
  const both = pair({ "a.txt": "a\n" }, COMMIT);

  for (const dir of [both.real, both.isolate]) {
    const bare = mkdtempSync(join(tmpdir(), "git-remote-"));

    realGit(bare, ["init", "-q", "--bare", "-b", "main", "."]);
    write(dir, "a.txt", "b\n");
    realGit(dir, ["commit", "-qam", "two"]);
    realGit(dir, ["remote", "add", "origin", bare]);
    realGit(dir, ["checkout", "-q", "-b", "ahead"]);
    write(dir, "c.txt", "c\n");
    realGit(dir, ["add", "c.txt"]);
    realGit(dir, ["commit", "-qm", "three"]);
    realGit(dir, ["push", "-q", "-u", "origin", "ahead"]);
    realGit(dir, ["checkout", "-q", "-b", "behind", "main"]);
    realGit(dir, ["push", "-q", "origin", "main~1:refs/heads/behind"]);
    realGit(dir, ["fetch", "-q", "origin"]);
    realGit(dir, ["branch", "--set-upstream-to=origin/behind", "behind"]);
    realGit(dir, ["checkout", "-q", "main"]);
  }

  return both;
}

test.each([["ahead"], ["behind"], ["ahead", "behind"]])(
  "git branch -d %s %s with an upstream matches real git",
  async (...names) => {
    const both = remotePair();
    const ran = await bothRun(both, ["branch", "-d", ...names]);

    expect(ran.isolate).toEqual(ran.real);
    expect(refs(both.isolate)).toEqual(refs(both.real));
  },
);
