import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { test } from "vitest";
import {
  directories,
  drawBases,
  drawContent,
  FLAG_SETS,
  PATHS,
  put,
  real,
  realStatus,
  remove,
  type Run,
  scratch,
} from "./git-status-fixtures.js";
import { isolateStatus } from "./git-status-isolate.js";
import { git, type Repos, sharedRules } from "./git-status-machine.js";

async function start(tc: hegel.TestCase, runs: readonly Run[], dirs: readonly string[]) {
  const bases = drawBases(tc);
  const initial = tc.draw(gs.arrays(gs.sampledFrom(PATHS), { maxSize: 5, unique: true }));
  const contents = initial.map((path) => [path, drawContent(tc, bases)] as const);
  const commits = tc.draw(gs.booleans());
  const state: Repos = { dirs, runs, bases };

  for (const [index, dir] of dirs.entries()) {
    await real(dir, ["init", "-q", "-b", "main"]);

    for (const [path, content] of contents) put(dir, path, content);

    await runs[index]?.(dir, ["add", "."]);
  }

  if (commits) await git(state, ["commit", "-q", "-m", "first"]);

  return state;
}

async function withRepositories(
  tc: hegel.TestCase,
  runs: readonly Run[],
  body: (state: Repos) => Promise<void>,
): Promise<void> {
  const dirs = runs.map(() => scratch());

  try {
    await body(await start(tc, runs, dirs));
  } finally {
    for (const dir of dirs) remove(dir);
  }
}

async function expectSameStatus(tc: hegel.TestCase, state: Repos): Promise<void> {
  const flags = tc.draw(gs.sampledFrom(FLAG_SETS));
  const expectedDir = state.dirs[0] ?? "";
  const prefix = tc.draw(gs.sampledFrom(directories(expectedDir)));
  const expected = realStatus(expectedDir, prefix, flags);
  const actual = await isolateStatus(state.dirs.at(-1) ?? "", prefix, flags);

  if (actual !== expected)
    throw new Error(
      `git status ${flags.join(" ")} from "${prefix}"\n--- isolate\n${actual}--- git\n${expected}`,
    );
}

test(
  "the isolate status matches real git after any sequence of changes made by real git",
  () =>
    hegel.testAsync(
      (tc) =>
        withRepositories(tc, [real], (state) =>
          hegel.stateful.runAsync(
            tc,
            {
              rules: {
                ...sharedRules,
                restoreWorktree: async (c, s) => {
                  await git(s, ["restore", c.draw(gs.sampledFrom(PATHS))]);
                },
              },
              invariants: { sameStatus: { check: expectSameStatus, alwaysCheck: true } },
            },
            state,
            { stepCount: 8 },
          ),
        ),
      { testCases: 6, suppressHealthCheck: [hegel.HealthCheck.TooSlow] },
    ),
  60_000,
);
