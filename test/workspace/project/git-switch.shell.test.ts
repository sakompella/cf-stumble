import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { bothRun, pair, realGit, state, write, type Pair } from "./git-pair.js";

const FORMS: readonly (readonly string[])[] = [
  ["switch", "nonexistent"],
  ["switch", "x-1"],
  ["switch", "origin/nope"],
  ["switch", "t1"],
  ["switch", "HEAD~1"],
  ["switch", "main~0"],
  ["switch", "HEAD"],
  ["switch", "heads/main"],
  ["switch", "refs/heads/side"],
  ["switch", "tags/nope"],
  ["switch", "a.txt"],
  ["switch", "side"],
  ["switch", "main"],
  ["switch", "--detach", "nope"],
];

test.each(FORMS)("git %s %s %s matches real git on two commits", async (...args) => {
  const both = pair({ "a.txt": "a\n" }, [
    ["add", "-A"],
    ["commit", "-q", "-m", "first"],
  ]);

  for (const dir of [both.real, both.isolate]) {
    write(dir, "a.txt", "b\n");
    realGit(dir, ["commit", "-qam", "two"]);
    realGit(dir, ["branch", "side", "HEAD~1"]);
    realGit(dir, ["tag", "t1"]);
  }

  const ran = await bothRun(both, [...args]);

  expect(ran.isolate).toEqual(ran.real);
  expect(state(both.isolate)).toEqual(state(both.real));
});

function remotePair(): Pair {
  const both = pair({ "a.txt": "a\n" }, [
    ["add", "-A"],
    ["commit", "-q", "-m", "first"],
  ]);

  for (const dir of [both.real, both.isolate]) {
    const bare = mkdtempSync(join(tmpdir(), "git-remote-"));

    realGit(bare, ["init", "-q", "--bare", "-b", "main", "."]);
    realGit(dir, ["remote", "add", "origin", bare]);
    realGit(dir, ["branch", "feat"]);
    realGit(dir, ["push", "-q", "origin", "main", "feat"]);
    realGit(dir, ["branch", "-q", "-D", "feat"]);
    realGit(dir, ["fetch", "-q", "origin"]);
  }

  return both;
}

function upstream(dir: string): readonly string[] {
  return [
    ["config", "--get-regexp", "^branch\\."],
    ["symbolic-ref", "-q", "HEAD"],
    ["for-each-ref", "--format=%(refname)"],
  ].map((args) => realGit(dir, args).stdout.split("\n").toSorted().join("\n"));
}

const REMOTE_FORMS: readonly (readonly string[])[] = [
  ["switch", "feat"],
  ["switch", "origin/feat"],
  ["switch", "origin/main"],
  ["switch", "nope"],
  ["checkout", "feat"],
  ["checkout", "origin/nope"],
  ["checkout", "main"],
];

test.each(REMOTE_FORMS)("git %s %s matches real git with a remote branch", async (...args) => {
  const both = remotePair();
  const ran = await bothRun(both, [...args]);

  expect(ran.isolate).toEqual(ran.real);
  expect(upstream(both.isolate)).toEqual(upstream(both.real));
});

test.each([["HEAD"], ["main"], ["t1"]])(
  "git switch %s matches real git on a detached HEAD",
  async (name) => {
    const both = pair({ "a.txt": "a\n" }, [
      ["add", "-A"],
      ["commit", "-q", "-m", "first"],
      ["tag", "t1"],
      ["checkout", "-q", "--detach"],
    ]);

    const ran = await bothRun(both, ["switch", name]);

    expect(ran.isolate).toEqual(ran.real);
    expect(state(both.isolate)).toEqual(state(both.real));
  },
);
