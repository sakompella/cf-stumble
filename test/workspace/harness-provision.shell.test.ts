import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, expect, test } from "vitest";
import { HARNESS_BUILD_CONFIGURATION } from "../../src/harness-build.js";
import { provisionHarness } from "../../src/workspace/harness-provision.js";
import { testHarnessCommit } from "../harness-commit-fixtures.js";
import {
  commitFile,
  git,
  makeRoot,
  originRepository,
  rooted,
  runRooted,
  type Origin,
  type Root,
} from "./rooted-shell.js";

let layout: Root;

let origin: Origin;

beforeEach(() => {
  layout = makeRoot("cf-stumble-harness-provision-");
  origin = originRepository(layout);
  commits(origin.path, "base", 60);
  git(layout.workspace, "clone", "-q", "--depth=50", origin.url, "harness");
});

afterEach(() => {
  rmSync(layout.root, { recursive: true, force: true });
});

const harness = (): string => join(layout.workspace, "harness");

function commits(repository: string, label: string, count: number): void {
  const branch = git(repository, "symbolic-ref", "HEAD");

  const stream = Array.from({ length: count }, (_, index) => {
    const message = `${label} ${String(index)}`;

    return [
      `commit ${branch}`,
      "committer t <t@example.invalid> 0 +0000",
      `data ${String(message.length)}`,
      message,
      ...(index === 0 ? [`from ${branch}^0`] : []),
      "",
    ].join("\n");
  });

  const ran = spawnSync("git", ["-C", repository, "fast-import", "--quiet"], {
    input: stream.join(""),
    encoding: "utf8",
  });

  if (ran.status !== 0) throw new Error(`git fast-import: ${ran.stderr}`);
}

function unsupported(): Promise<never> {
  return Promise.reject(new Error("not used once the checkout exists"));
}

const person = { name: "t", email: "t@example.invalid", timestamp: 0, timezoneOffset: 0 };

const workspace: Parameters<typeof provisionHarness>[0] = {
  fs: {
    readFile: unsupported,
    readdir: unsupported,
    stat: (path) =>
      Promise.resolve({
        name: ".git",
        parentPath: path,
        size: 0,
        mtime: 0,
        inode: 1,
        mode: 0o755,
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
      }),
    rm: unsupported,
    mkdir: unsupported,
    rename: unsupported,
  },
  git: {
    clone: unsupported,
    configSet: unsupported,
    configGet: () => Promise.resolve(HARNESS_BUILD_CONFIGURATION.harnessGitRemote),
    show: ({ ref }) =>
      Promise.resolve({
        oid: ref,
        message: "",
        tree: "",
        parent: [],
        author: person,
        committer: person,
      }),
  },
};

function container(source: string) {
  return Effect.sync(() => {
    const ran = runRooted(layout, rooted(source, layout));

    return { stdout: ran.stdout, stderr: ran.stderr, exitCode: ran.status ?? 1 };
  });
}

function provision() {
  const head = testHarnessCommit(git(harness(), "rev-parse", "HEAD"));

  return Effect.runPromise(
    provisionHarness(workspace, container, HARNESS_BUILD_CONFIGURATION, head),
  );
}

const ok = { stdout: "", stderr: "", exitCode: 0 };

const stuck = (head: string) => ({
  stdout: "",
  stderr: `harness checkout not updated: cannot fast-forward from ${head.slice(0, 7)}\n`,
  exitCode: 0,
});

test("fast-forwards a shallow checkout whose upstream moved more than 50 commits ahead through a merge", async () => {
  git(origin.path, "checkout", "-q", "-b", "side");
  commits(origin.path, "side", 40);
  git(origin.path, "checkout", "-q", "main");
  commits(origin.path, "main", 30);
  git(origin.path, "merge", "-q", "--no-ff", "-m", "merge side", "side");

  await expect(provision()).resolves.toEqual(ok);
  expect(git(harness(), "rev-parse", "HEAD")).toBe(git(origin.path, "rev-parse", "HEAD"));
});

test("leaves a checkout that already contains its upstream as it is", async () => {
  const local = commitFile(harness(), "local.txt", "local");

  await expect(provision()).resolves.toEqual(ok);
  expect(git(harness(), "rev-parse", "HEAD")).toBe(local);
});

test("leaves a checkout with local tracked changes as it is, with a message", async () => {
  const head = git(harness(), "rev-parse", "HEAD");
  commits(origin.path, "ahead", 1);
  writeFileSync(join(harness(), "first.txt"), "edited");

  await expect(provision()).resolves.toEqual({
    stdout: "",
    stderr: `harness checkout has local changes; left at ${head.slice(0, 7)}\n`,
    exitCode: 0,
  });
  expect(git(harness(), "rev-parse", "HEAD")).toBe(head);
});

test("leaves a checkout that diverged from its upstream with cannot fast-forward", async () => {
  const local = commitFile(harness(), "local.txt", "local");
  commits(origin.path, "ahead", 1);

  await expect(provision()).resolves.toEqual(stuck(local));
  expect(git(harness(), "rev-parse", "HEAD")).toBe(local);
});

test("leaves a detached checkout with cannot fast-forward", async () => {
  const head = git(harness(), "rev-parse", "HEAD");
  git(harness(), "checkout", "-q", "--detach");
  commits(origin.path, "ahead", 1);

  await expect(provision()).resolves.toEqual(stuck(head));
  expect(git(harness(), "rev-parse", "HEAD")).toBe(head);
});
