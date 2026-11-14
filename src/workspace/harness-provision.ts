import type { Workspace } from "@cloudflare/computer";
import * as Effect from "effect/Effect";
import type { HarnessBuildConfiguration } from "../harness-build.js";
import type { HarnessCommit } from "../harness-commit.js";
import { durableGitHubConfigurationSource } from "../github/index.js";
import { shellQuote } from "../shell-quote.js";
import { hasErrnoCode } from "./errno-code.js";
import { cloneIntoPlace, githubToken } from "./isolate-clone.js";
import { attemptWorkspace, type CommandOutput, type WorkspaceFault } from "./operations.js";

const HARNESS_CLONE_DEPTH = 50;

type Git = Pick<Workspace["git"], "clone" | "configSet" | "configGet" | "show">;

type HarnessWorkspace = Readonly<{
  fs: Pick<Workspace["fs"], "readFile" | "readdir" | "stat" | "rm" | "mkdir" | "rename">;
  git: Git;
}>;

type Container = (source: string) => Effect.Effect<CommandOutput, WorkspaceFault>;

function failed(message: string): CommandOutput {
  return { stdout: "", stderr: `${message}\n`, exitCode: 1 };
}

async function entryCount(workspace: HarnessWorkspace, path: string): Promise<number> {
  try {
    return (await workspace.fs.readdir(path)).length;
  } catch (cause) {
    if (hasErrnoCode(cause) && cause.code === "ENOENT") return 0;
    throw cause;
  }
}

async function isRepository(workspace: HarnessWorkspace, gitDir: string): Promise<boolean> {
  try {
    return (await workspace.fs.stat(gitDir)).isDirectory;
  } catch (cause) {
    if (hasErrnoCode(cause) && cause.code === "ENOENT") return false;
    throw cause;
  }
}

async function hasCommit(git: Git, dir: string, commit: HarnessCommit): Promise<boolean> {
  try {
    await git.show({ dir, ref: commit });

    return true;
  } catch {
    return false;
  }
}

function fetchCommitSource(dir: string, commit: HarnessCommit): string {
  return [
    "set -eu",
    ...durableGitHubConfigurationSource(),
    `git -C ${shellQuote(dir)} fetch --quiet --depth=${HARNESS_CLONE_DEPTH} origin ${commit}`,
    `git -C ${shellQuote(dir)} cat-file -e ${commit}^{commit}`,
  ].join("\n");
}

function advanceSource(dir: string): string {
  return [
    "set -eu",
    ...durableGitHubConfigurationSource(),
    `cd ${shellQuote(dir)}`,
    'head="$(git rev-parse --short=7 HEAD)"',
    "stuck() {",
    `  printf 'harness checkout not updated: cannot fast-forward from %s\\n' "$head" >&2`,
    "  exit 0",
    "}",
    'branch="$(git symbolic-ref --quiet --short HEAD)" || stuck',
    'upstream="refs/remotes/origin/$branch"',
    'if ! git fetch --quiet origin "+refs/heads/$branch:$upstream" 2>/dev/null; then',
    "  printf 'harness checkout not updated: fetch failed\\n' >&2",
    "  exit 0",
    "fi",
    "if ! git diff --quiet HEAD --; then",
    `  printf 'harness checkout has local changes; left at %s\\n' "$head" >&2`,
    "  exit 0",
    "fi",
    "while :; do",
    '  git merge-base --is-ancestor "$upstream" HEAD 2>/dev/null && exit 0',
    '  if git merge-base --is-ancestor HEAD "$upstream" 2>/dev/null; then',
    '    git merge --ff-only --quiet "$upstream" >/dev/null 2>&1 || stuck',
    "    exit 0",
    "  fi",
    '  [ "$(git rev-parse --is-shallow-repository)" = true ] || stuck',
    '  git fetch --quiet --unshallow origin "+refs/heads/$branch:$upstream" 2>/dev/null || stuck',
    "done",
  ].join("\n");
}

export function provisionHarness(
  workspace: HarnessWorkspace,
  container: Container,
  configuration: HarnessBuildConfiguration,
  commit: HarnessCommit,
): Effect.Effect<CommandOutput, WorkspaceFault> {
  const dir = configuration.harnessRepositoryRoot;
  const remote = configuration.harnessGitRemote;
  const { git } = workspace;

  return Effect.gen(function* () {
    if (!(yield* attemptWorkspace(() => isRepository(workspace, configuration.harnessGitDir)))) {
      if ((yield* attemptWorkspace(() => entryCount(workspace, dir))) > 0) {
        return failed(`${dir} is not a git repository and is not empty`);
      }

      yield* attemptWorkspace(() => workspace.fs.rm(dir, { recursive: true, force: true }));
      yield* cloneIntoPlace(workspace, {
        url: remote,
        root: dir,
        depth: HARNESS_CLONE_DEPTH,
        token: yield* githubToken(workspace),
      });
    }

    const origin = yield* attemptWorkspace(() =>
      git.configGet({ dir, path: "remote.origin.url", all: true }),
    );

    if (String(origin) !== remote) return failed(`${dir} has a different origin than ${remote}`);

    if (!(yield* attemptWorkspace(() => hasCommit(git, dir, commit)))) {
      const fetched = yield* container(fetchCommitSource(dir, commit));

      if (fetched.exitCode !== 0) {
        const reason = fetched.stderr.trim();

        return failed(`harness commit ${commit} is not in ${remote}${reason && `: ${reason}`}`);
      }
    }

    const advanced = yield* container(advanceSource(dir));

    return { stdout: "", stderr: advanced.stderr, exitCode: 0 };
  });
}
