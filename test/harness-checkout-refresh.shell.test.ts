import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { devShellTool } from "./dev-shell-tool.js";
import { HARNESS_BUILD_CONFIGURATION, provisionHarnessRepository } from "../src/harness-build.js";
import { testHarnessCommit } from "./harness-commit-fixtures.js";
import {
  FLOCK_STAND_IN,
  scratchDirectory,
  systemToolsDirectory,
  underScratch,
  writeExecutable,
} from "./workspace/planned-shell-fixture.js";

const scratch = scratchDirectory("cf-stumble-harness-refresh-");

const identity = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

let counter = 0;

beforeAll(() => {
  mkdirSync(join(scratch, "bin"));
  writeExecutable(join(scratch, "bin", "flock"), FLOCK_STAND_IN);
  symlinkSync(devShellTool("git"), join(scratch, "bin", "git"));
  systemTools = systemToolsDirectory(scratch);
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

let systemTools = "";

function git(directory: string, ...args: readonly string[]): string {
  const ran = spawnSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    env: { ...identity, PATH: join(scratch, "bin"), GIT_CONFIG_GLOBAL: "/dev/null" },
  });

  expect(ran.status, ran.stderr).toBe(0);

  return ran.stdout.trim();
}

function advanceRemote(remote: string, content: string): string {
  writeFileSync(join(remote, "file.txt"), content);
  git(remote, "add", ".");
  git(remote, "commit", "-q", "-m", content);

  return git(remote, "rev-parse", "HEAD");
}

type Provisioned = Readonly<{ root: string; remote: string; checkout: string }>;

function provision(root: string, remote: string, commit: string): string {
  const source = underScratch(
    provisionHarnessRepository(
      { ...HARNESS_BUILD_CONFIGURATION, harnessGitRemote: `file://${remote}` },
      testHarnessCommit(commit),
    ),
    root,
  );

  const ran = spawnSync(devShellTool("sh"), ["-c", source], {
    encoding: "utf8",
    env: { PATH: `${join(scratch, "bin")}:${systemTools}`, ...identity },
  });

  expect(ran.status, ran.stderr).toBe(0);

  return ran.stderr;
}

function clonedHarness(): Provisioned & Readonly<{ first: string }> {
  counter += 1;
  const root = join(scratch, String(counter));
  const remote = join(root, "remote");
  mkdirSync(remote, { recursive: true });
  mkdirSync(join(root, "tmp"));
  git(remote, "init", "-q", "-b", "main");
  const first = advanceRemote(remote, "one");
  provision(root, remote, first);

  return { root, remote, checkout: join(root, "workspace", "harness"), first };
}

test("a clean checkout moves to the remote's newest commit", () => {
  const { root, remote, checkout } = clonedHarness();
  const second = advanceRemote(remote, "two");

  provision(root, remote, second);

  expect(git(checkout, "rev-parse", "HEAD")).toBe(second);
  expect(readFileSync(join(checkout, "file.txt"), "utf8")).toBe("two");
});

test("a checkout with a modified file keeps its edit and says so", () => {
  const { root, remote, checkout, first } = clonedHarness();
  writeFileSync(join(checkout, "file.txt"), "mine");
  const second = advanceRemote(remote, "two");

  const stderr = provision(root, remote, second);

  expect(git(checkout, "rev-parse", "HEAD")).toBe(first);
  expect(readFileSync(join(checkout, "file.txt"), "utf8")).toBe("mine");
  expect(stderr).toContain("local changes");
});

test("a checkout with its own commit is left alone and says so", () => {
  const { root, remote, checkout } = clonedHarness();
  writeFileSync(join(checkout, "own.txt"), "own");
  git(checkout, "add", ".");
  git(checkout, "commit", "-q", "-m", "own");
  const own = git(checkout, "rev-parse", "HEAD");
  const second = advanceRemote(remote, "two");

  const stderr = provision(root, remote, second);

  expect(git(checkout, "rev-parse", "HEAD")).toBe(own);
  expect(stderr).toContain("cannot fast-forward");
});
