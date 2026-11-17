import { rmSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readHarnessLineage } from "../../src/workspace/commands/harness-lineage.js";
import {
  commitFile,
  git,
  makeRoot,
  originRepository,
  rooted,
  runRooted,
  type Root,
} from "./rooted-shell.js";
import { workspaceEffects } from "./promise-operations.js";

let layout: Root;

let first = "";

let second = "";

let third = "";

let side = "";

beforeEach(() => {
  layout = makeRoot("cf-stumble-harness-lineage-");
  const origin = originRepository(layout);
  first = git(origin.path, "rev-parse", "HEAD");
  second = commitFile(origin.path, "second.txt", "second");
  third = commitFile(origin.path, "third.txt", "third");
  git(layout.workspace, "clone", "-q", origin.url, "harness");
  git(harness(), "checkout", "-q", "-b", "side", first);
  side = commitFile(harness(), "side.txt", "side");
});

afterEach(() => {
  rmSync(layout.root, { recursive: true, force: true });
});

const harness = (): string => join(layout.workspace, "harness");

function lineage(activeCommit: string, harnessCommit: string) {
  const operations = workspaceEffects({
    lstat: () => Promise.reject(new Error("the lineage reads no path")),
    readFile: () => Promise.reject(new Error("the lineage reads no file")),
    writeFile: () => Promise.resolve(),
    runCommand: (source) => {
      const ran = runRooted(layout, rooted(source, layout));

      return Promise.resolve({ stdout: ran.stdout, stderr: ran.stderr, exitCode: ran.status ?? 1 });
    },
  });

  return Effect.runPromise(readHarnessLineage(operations, { activeCommit, harnessCommit }));
}

test("an active commit behind the target is contained, and main is ahead by the commits after each", async () => {
  await expect(lineage(first, second)).resolves.toEqual({
    containsActive: true,
    mainAheadOfActive: 2,
    mainAheadOfTarget: 1,
  });
});

test("an active commit on another line is not contained, and main is ahead of it by all it lacks", async () => {
  await expect(lineage(side, third)).resolves.toEqual({
    containsActive: false,
    mainAheadOfActive: 2,
    mainAheadOfTarget: 0,
  });
});

test("a commit the checkout does not hold leaves the answer unknown", async () => {
  await expect(lineage("9".repeat(40), third)).resolves.toEqual({
    containsActive: undefined,
    mainAheadOfActive: undefined,
    mainAheadOfTarget: 0,
  });
});
