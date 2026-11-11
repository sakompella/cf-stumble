import * as fsp from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { Workspace } from "@cloudflare/computer";
import { createGitClient } from "@cloudflare/computer/git";
import { expect, test } from "vitest";
import { isolateGitWith, pair } from "./git-pair.js";

const SLOW_MKDIR_MS = 100;

const workspace = new Workspace({
  storage: {
    sql: { exec: () => ({ toArray: () => [] }) },
    transactionSync: (closure) => closure(),
  },
});

const slowDirectories = createGitClient({
  adapter: () =>
    Promise.resolve({
      promises: {
        ...fsp,
        mkdir: async (...args: Parameters<typeof fsp.mkdir>) => {
          await pause(SLOW_MKDIR_MS);

          return fsp.mkdir(...args);
        },
      },
    }),
})({ ws: { provider: () => workspace.provider() } });

test("git stash list creates the stash directories before it returns", async () => {
  const both = pair({ "a.txt": "a\n" });

  await isolateGitWith(
    slowDirectories.cli.bind(slowDirectories),
    both.isolate,
    ["stash", "list"],
    slowDirectories,
  );

  expect(existsSync(join(both.isolate, ".git", "logs", "refs"))).toBe(true);
});
