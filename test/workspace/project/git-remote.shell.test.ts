import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitCliResult } from "@cloudflare/computer/git";
import { expect, test } from "vitest";
import { bothRun, isolateGitWith, normalisedResult, pair, realGit, type Pair } from "./git-pair.js";

const FORMS: readonly (readonly string[])[] = [
  ["push", "origin", "HEAD:x"],
  ["push", "origin", "main"],
  ["push", "-u", "origin", "main"],
  ["push"],
  ["push", "origin"],
  ["push", "origin", "--delete", "x"],
  ["push", "origin", ":x"],
  ["push", "--force", "origin", "main"],
  ["push", "./x", "main"],
  ["pull"],
  ["pull", "origin", "main"],
  ["fetch"],
  ["fetch", "origin"],
  ["fetch", "nope", "main"],
];

const COMMIT = [
  ["add", "-A"],
  ["commit", "-q", "-m", "first"],
];

test.each(FORMS)(
  "git %s %s %s %s without a remote matches real git on an unborn branch",
  async (...args) => {
    const both = pair({});
    const ran = await bothRun(both, [...args]);

    expect(ran.isolate).toEqual(ran.real);
  },
);

test.each(FORMS)(
  "git %s %s %s %s without a remote matches real git after a commit",
  async (...args) => {
    const both = pair({ "a.txt": "a\n" }, COMMIT);
    const ran = await bothRun(both, [...args]);

    expect(ran.isolate).toEqual(ran.real);
  },
);

function remotePair(): Pair {
  const bare = mkdtempSync(join(tmpdir(), "git-remote-"));
  realGit(bare, ["init", "-q", "--bare", "-b", "main", "."]);

  const both = pair({ "a.txt": "a\n" }, [...COMMIT, ["remote", "add", "origin", bare]]);

  realGit(both.real, ["branch", "feat"]);
  realGit(both.isolate, ["branch", "feat"]);

  return both;
}

function upstream(dir: string, branch: string): string {
  return ["remote", "merge"]
    .map((key) => realGit(dir, ["config", "--get", `branch.${branch}.${key}`]).stdout)
    .join("|");
}

const SUCCEEDS = (): Promise<GitCliResult> =>
  Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });

const UPSTREAMS: readonly (readonly string[])[] = [
  ["push", "-u", "origin", "main"],
  ["push", "--set-upstream", "origin", "feat:other"],
  ["push", "-u", "origin", "HEAD"],
  ["push", "-u", "origin"],
];

test.each(UPSTREAMS)("git %s %s %s %s sets the upstream like git", async (...args) => {
  const both = remotePair();
  const real = realGit(both.real, args);
  const isolate = await isolateGitWith(SUCCEEDS, both.isolate, args);

  expect(isolate.stdout).toBe(real.stdout);

  for (const dir of [both.real, both.isolate])
    expect(["feat", "main"].map((name) => upstream(dir, name))).toEqual(
      ["feat", "main"].map((name) => upstream(both.real, name)),
    );
});

const LOST = (): Promise<GitCliResult> =>
  Promise.resolve({
    stdout: "",
    stderr: "git fetch: git fetch failed: Could not find nope.\n",
    exitCode: 1,
  });

test.each(["nope", "nope:refs/remotes/origin/nope"])(
  "git fetch origin %s exits 128 with git's text",
  async (ref) => {
    const both = remotePair();

    const real = normalisedResult(realGit(both.real, ["fetch", "origin", ref]), both.real);
    const isolate = await isolateGitWith(LOST, both.isolate, ["fetch", "origin", ref]);

    expect(isolate).toEqual(real);
  },
);
