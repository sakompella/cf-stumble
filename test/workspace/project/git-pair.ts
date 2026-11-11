import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Workspace } from "@cloudflare/computer";
import { createGitClient, type GitCliInput, type GitCliResult } from "@cloudflare/computer/git";
import { afterEach } from "vitest";
import type { WorkFiles } from "../../../src/workspace/project/git-index-file.js";
import { gitCli } from "../../../src/workspace/project/git-cli.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const workspace = new Workspace({
  storage: {
    sql: { exec: () => ({ toArray: () => [] }) },
    transactionSync: (closure) => closure(),
  },
});

export const client = createGitClient({ adapter: () => Promise.resolve({ promises: fsp }) })({
  ws: { provider: () => workspace.provider() },
});

const FIXED_DATE = "2026-01-02T03:04:05Z";

const IDENTITY = ["-c", "user.name=T", "-c", "user.email=t@e"];

const GIT_IDENTITY_VARIABLES = new Set([
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
]);

const realGitEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !GIT_IDENTITY_VARIABLES.has(name)),
  ),
  GIT_AUTHOR_DATE: FIXED_DATE,
  GIT_COMMITTER_DATE: FIXED_DATE,
};

export function realGit(dir: string, args: readonly string[]): GitCliResult {
  const ran = spawnSync("git", ["-C", dir, ...IDENTITY, ...args], {
    encoding: "utf8",
    env: realGitEnv,
  });

  return { stdout: ran.stdout, stderr: ran.stderr, exitCode: ran.status ?? -1 };
}

async function removeFile(path: string, stop: string): Promise<void> {
  unlinkSync(path);

  let directory = dirname(path);

  while (directory.length > stop.length && readdirSync(directory).length === 0) {
    rmdirSync(directory);
    directory = dirname(directory);
  }

  await Promise.resolve();
}

function listFiles(root: string, relative = ""): readonly string[] {
  return readdirSync(join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;

    if (!entry.isDirectory()) return [path];

    return entry.name === ".git" && relative === "" ? [] : listFiles(root, path);
  });
}

const FILES: WorkFiles = {
  read: (path) => fsp.readFile(path),
  remove: removeFile,
  rename: async (from, to) => {
    await fsp.mkdir(dirname(to), { recursive: true });
    await fsp.rename(from, to);
  },
  list: (root) => Promise.resolve(listFiles(root)),
  mkdir: async (path) => {
    await fsp.mkdir(path, { recursive: true });
  },
};

export function isolateGitWith(
  cli: (input: GitCliInput) => Promise<GitCliResult>,
  dir: string,
  args: readonly string[],
  gitClient: typeof client = client,
): Promise<GitCliResult> {
  return gitCli(gitClient, cli, { argv: [...IDENTITY, ...args], cwd: dir }, FILES);
}

export function isolateGit(dir: string, args: readonly string[]): Promise<GitCliResult> {
  return isolateGitWith(client.cli.bind(client), dir, args);
}

export type Files = Readonly<Record<string, string>>;

export interface Pair {
  readonly real: string;
  readonly isolate: string;
}

export function pair(files: Files, setup: readonly (readonly string[])[] = []): Pair {
  const root = mkdtempSync(join(tmpdir(), "git-pair-"));
  roots.push(root);

  const dirs = ["real", "isolate"].map((name) => join(root, name));

  for (const dir of dirs) {
    mkdirSync(dir);
    realGit(dir, ["init", "-q", "-b", "main", "."]);

    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), content);
    }

    for (const step of setup) realGit(dir, step);
  }

  return { real: dirs[0] ?? "", isolate: dirs[1] ?? "" };
}

export function write(dir: string, name: string, content: string): void {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), content);
}

export function exists(dir: string, name: string): boolean {
  try {
    readFileSync(join(dir, name));

    return true;
  } catch {
    return false;
  }
}

const ABBREVIATION = /\b[0-9a-f]{7,40}\b/gu;

function normalised(text: string, dir: string): string {
  return text.replaceAll(dir, "<dir>").replaceAll(ABBREVIATION, "<sha>");
}

export function normalisedResult(result: GitCliResult, dir: string): GitCliResult {
  return {
    stdout: normalised(result.stdout, dir),
    stderr: normalised(result.stderr, dir),
    exitCode: result.exitCode,
  };
}

export function state(dir: string): readonly string[] {
  return [
    ["status", "--porcelain=v1", "-b"],
    ["ls-files", "-s"],
    ["for-each-ref", "--format=%(refname) %(tree)"],
    ["symbolic-ref", "-q", "HEAD"],
    ["config", "--local", "-l"],
  ].map((args) => {
    const result = realGit(dir, args);

    return `${args.join(" ")} ${result.exitCode}\n${result.stdout}`;
  });
}

export async function bothRun(
  both: Pair,
  args: readonly string[],
): Promise<{ readonly real: GitCliResult; readonly isolate: GitCliResult }> {
  return {
    real: normalisedResult(realGit(both.real, args), both.real),
    isolate: normalisedResult(await isolateGit(both.isolate, args), both.isolate),
  };
}
