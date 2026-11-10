import type * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type Base,
  directoryFor,
  drawContent,
  files,
  PATHS,
  put,
  type Run,
} from "./git-status-fixtures.js";

export interface Repos {
  readonly dirs: readonly string[];
  readonly runs: readonly Run[];
  readonly bases: readonly Base[];
}

export async function git(state: Repos, args: readonly string[]): Promise<void> {
  for (const [index, run] of state.runs.entries()) await run(state.dirs[index] ?? "", args);
}

function everywhere(state: Repos, change: (dir: string) => void): void {
  for (const dir of state.dirs) change(dir);
}

const path = gs.sampledFrom(PATHS);

function existing(tc: hegel.TestCase, state: Repos): string {
  const found = files(state.dirs[0] ?? "");

  tc.assume(found.length > 0);

  return tc.draw(gs.sampledFrom(found));
}

function moved(tc: hegel.TestCase, state: Repos): readonly [string, string] {
  const from = existing(tc, state);
  const to = tc.draw(path);

  tc.assume(from !== to);

  return [from, to];
}

export const sharedRules = {
  write: (tc, state) => {
    const target = tc.draw(path);
    const content = drawContent(tc, state.bases);

    everywhere(state, (dir) => {
      put(dir, target, content);
    });
  },
  edit: (tc, state) => {
    const target = existing(tc, state);
    const content = drawContent(tc, state.bases);

    everywhere(state, (dir) => {
      put(dir, target, content);
    });
  },
  remove: (tc, state) => {
    const target = existing(tc, state);

    everywhere(state, (dir) => {
      rmSync(join(dir, target));
    });
  },
  move: (tc, state) => {
    const [from, to] = moved(tc, state);

    everywhere(state, (dir) => {
      directoryFor(dir, to);
      renameSync(join(dir, from), join(dir, to));
    });
  },
  gitMove: async (tc, state) => {
    const [from, to] = moved(tc, state);

    everywhere(state, (dir) => {
      directoryFor(dir, to);
    });
    await git(state, ["mv", from, to]);
  },
  addEverything: async (tc, state) => {
    await git(state, ["add", ...tc.draw(gs.sampledFrom([["."], ["-u"], ["-A"]]))]);
  },
  addPaths: async (tc, state) => {
    await git(state, ["add", ...tc.draw(gs.arrays(path, { minSize: 1, maxSize: 2 }))]);
  },
  removeTracked: async (tc, state) => {
    const flags = tc.draw(gs.sampledFrom([["-f"], ["--cached"]]));

    await git(state, ["rm", "-q", ...flags, existing(tc, state)]);
  },
  unstage: async (tc, state) => {
    const verb = tc.draw(
      gs.sampledFrom([
        ["restore", "--staged"],
        ["reset", "-q"],
      ]),
    );

    await git(state, [...verb, existing(tc, state)]);
  },
  commit: async (_tc, state) => {
    await git(state, ["commit", "-q", "-m", "m"]);
  },
} satisfies Record<string, hegel.stateful.Rule<Repos>>;
