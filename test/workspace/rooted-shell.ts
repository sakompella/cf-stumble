import { devShellTool } from "../dev-shell-tool.js";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLOCK_STAND_IN, writeExecutable } from "./planned-shell-fixture.js";

export type Root = Readonly<{ root: string; workspace: string; tmp: string; bin: string }>;

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

export function makeRoot(prefix: string): Root {
  const root = mkdtempSync(join(tmpdir(), prefix));

  const layout = {
    root,
    workspace: join(root, "workspace"),
    tmp: join(root, "tmp"),
    bin: join(root, "bin"),
  };

  for (const directory of [layout.workspace, layout.tmp, layout.bin]) mkdirSync(directory);

  writeExecutable(join(layout.bin, "flock"), FLOCK_STAND_IN);
  writeExecutable(join(layout.bin, "gh"), "#!/bin/sh\nexit 1\n");

  return layout;
}

export function rooted(source: string, { root }: Root): string {
  return source.replaceAll(/\/(workspace|tmp)(?![\w.-])/gu, `${root}/$1`);
}

export function runRooted(
  layout: Root,
  source: string,
  environment: Readonly<Record<string, string>> = {},
): SpawnSyncReturns<string> {
  return spawnSync(devShellTool("sh"), ["-c", source], {
    cwd: layout.workspace,
    encoding: "utf8",
    env: {
      PATH: `${layout.bin}:${process.env["PATH"] ?? ""}`,
      HOME: layout.root,
      ...GIT_IDENTITY,
      ...environment,
    },
  });
}

export function git(directory: string, ...args: readonly string[]): string {
  const ran = spawnSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...GIT_IDENTITY },
  });

  if (ran.status !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr}`);

  return ran.stdout.trim();
}

export function commitFile(repository: string, name: string, content: string): string {
  writeFileSync(join(repository, name), content);
  git(repository, "add", name);
  git(repository, "commit", "-q", "-m", name);

  return git(repository, "rev-parse", "HEAD");
}

export type Origin = Readonly<{ path: string; url: string }>;

export function originRepository(layout: Root): Origin {
  const path = join(layout.root, "origin");
  mkdirSync(path);
  git(path, "init", "-q", "-b", "main");
  commitFile(path, "first.txt", "first");

  return { path, url: `file://${path}` };
}
