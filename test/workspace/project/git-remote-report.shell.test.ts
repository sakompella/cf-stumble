import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitCliInput, GitCliResult } from "@cloudflare/computer/git";
import { expect, test } from "vitest";
import { isolateGitWith, normalisedResult, pair, realGit } from "./git-pair.js";

type Step = readonly [where: "repo" | "other", ...args: string[]];

const COMMIT: Step = ["repo", "commit", "-q", "--allow-empty", "-m", "first"];

const PUSH_MAIN: Step = ["repo", "push", "-q", "origin", "main"];

const MORE: Step = ["repo", "commit", "-q", "--allow-empty", "-m", "second"];

const OTHER: readonly Step[] = [
  ["other", "commit", "-q", "--allow-empty", "-m", "theirs"],
  ["other", "push", "-q", "origin", "main"],
];

const FEAT: readonly Step[] = [
  ["other", "branch", "feat"],
  ["other", "push", "-q", "origin", "feat"],
];

const CLONED: readonly Step[] = [COMMIT, PUSH_MAIN, ["other", "pull", "-q", "origin", "main"]];

interface Case {
  readonly name: string;
  readonly setup: readonly Step[];
  readonly args: readonly string[];
}

const PUSHES: readonly Case[] = [
  { name: "a new branch", setup: [COMMIT], args: ["push", "origin", "main"] },
  { name: "a new branch with -u", setup: [COMMIT], args: ["push", "-u", "origin", "main"] },
  { name: "a renamed branch", setup: [COMMIT], args: ["push", "origin", "main:other"] },
  { name: "HEAD", setup: [COMMIT], args: ["push", "origin", "HEAD"] },
  { name: "HEAD to a name", setup: [COMMIT], args: ["push", "origin", "HEAD:x"] },
  { name: "a fast-forward", setup: [COMMIT, PUSH_MAIN, MORE], args: ["push", "origin", "main"] },
  { name: "up to date", setup: [COMMIT, PUSH_MAIN], args: ["push", "origin", "main"] },
  {
    name: "with an upstream",
    setup: [COMMIT, ["repo", "push", "-q", "-u", "origin", "main"], MORE],
    args: ["push"],
  },
  {
    name: "a deleted branch",
    setup: [COMMIT, ["repo", "push", "-q", "origin", "main:gone"]],
    args: ["push", "origin", "--delete", "gone"],
  },
  {
    name: "a deleted branch by colon",
    setup: [COMMIT, ["repo", "push", "-q", "origin", "main:gone"]],
    args: ["push", "origin", ":gone"],
  },
  {
    name: "a forced update",
    setup: [COMMIT, PUSH_MAIN, ["repo", "commit", "-q", "--amend", "--allow-empty", "-m", "again"]],
    args: ["push", "--force", "origin", "main"],
  },
  {
    name: "two branches",
    setup: [COMMIT, PUSH_MAIN, ["repo", "branch", "feat"], MORE],
    args: ["push", "origin", "main", "feat"],
  },
];

const FETCHES: readonly Case[] = [
  { name: "new branches", setup: [...CLONED, ...FEAT], args: ["fetch"] },
  { name: "a fast-forward", setup: [...CLONED, ...OTHER], args: ["fetch", "origin"] },
  {
    name: "a fast-forward and a new branch",
    setup: [...CLONED, ...OTHER, ...FEAT],
    args: ["fetch"],
  },
  { name: "nothing new", setup: [...CLONED], args: ["fetch"] },
  { name: "one branch", setup: [...CLONED, ...OTHER], args: ["fetch", "origin", "main"] },
  { name: "one branch, up to date", setup: [...CLONED], args: ["fetch", "origin", "main"] },
  {
    name: "a forced update",
    setup: [
      ...CLONED,
      ["other", "commit", "-q", "--amend", "--allow-empty", "-m", "rewritten"],
      ["other", "push", "-q", "--force", "origin", "main"],
    ],
    args: ["fetch"],
  },
];

const PULLS: readonly Case[] = [
  { name: "a fast-forward", setup: [...CLONED, ...OTHER], args: ["pull"] },
  { name: "a named branch", setup: [...CLONED, ...OTHER], args: ["pull", "origin", "main"] },
];

interface Side {
  readonly repo: string;
  readonly other: string;
  readonly bare: string;
}

function side(repo: string, steps: readonly Step[]): Side {
  const bare = mkdtempSync(join(tmpdir(), "git-report-bare-"));
  const other = mkdtempSync(join(tmpdir(), "git-report-other-"));

  realGit(bare, ["init", "-q", "--bare", "-b", "main", "."]);
  realGit(repo, ["remote", "add", "origin", bare]);
  realGit(repo, ["config", "pull.rebase", "false"]);
  realGit(other, ["clone", "-q", bare, "."]);
  realGit(other, ["config", "pull.rebase", "false"]);

  const dirs = { repo, other };

  for (const [where, ...args] of steps) {
    const ran = realGit(dirs[where], args);

    if (ran.exitCode !== 0) throw new Error(`${args.join(" ")}: ${ran.stderr}`);
  }

  return { repo, other, bare };
}

function normalised(result: GitCliResult, dir: string, bare: string): GitCliResult {
  const plain = normalisedResult(result, dir);

  return {
    ...plain,
    stdout: plain.stdout.replaceAll(bare, "<bare>"),
    stderr: plain.stderr.replaceAll(bare, "<bare>"),
  };
}

const PERFORMS = (input: GitCliInput): Promise<GitCliResult> => {
  const ran = realGit(input.cwd ?? "/", input.argv);

  return Promise.resolve({ stdout: "", stderr: "", exitCode: ran.exitCode });
};

async function compare(kase: Case, streams: readonly ("stdout" | "stderr")[]): Promise<void> {
  const both = pair({}, []);
  const real = side(both.real, kase.setup);
  const isolate = side(both.isolate, kase.setup);

  const expected = normalised(realGit(both.real, kase.args), both.real, real.bare);

  const actual = normalised(
    await isolateGitWith(PERFORMS, both.isolate, kase.args),
    both.isolate,
    isolate.bare,
  );

  for (const stream of streams) expect(actual[stream]).toBe(expected[stream]);

  expect(actual.exitCode).toBe(expected.exitCode);
}

test.each(PUSHES)("git push reports $name like git", (kase) => compare(kase, ["stdout", "stderr"]));

test.each(FETCHES)("git fetch reports $name like git", (kase) =>
  compare(kase, ["stdout", "stderr"]),
);

test.each(PULLS)("git pull reports $name like git on stderr", (kase) => compare(kase, ["stderr"]));
