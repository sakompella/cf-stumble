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

type HarnessWorkspace = Readonly<{
  fs: Pick<Workspace["fs"], "readFile" | "readdir" | "stat" | "rm" | "mkdir" | "rename">;
  git: Pick<Workspace["git"], "clone" | "configSet">;
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

function harnessSource(dir: string, remote: string, commit: HarnessCommit): string {
  return [
    "set -eu",
    ...durableGitHubConfigurationSource(),
    `cd ${shellQuote(dir)}`,
    `if [ "$(git config --get-all remote.origin.url)" != ${shellQuote(remote)} ]; then`,
    `  printf '%s has a different origin than %s\\n' ${shellQuote(dir)} ${shellQuote(remote)} >&2`,
    "  exit 1",
    "fi",
    `if ! git cat-file -e ${commit}^{commit} 2>/dev/null; then`,
    `  if ! reason="$(git fetch --quiet --depth=${HARNESS_CLONE_DEPTH} origin ${commit} 2>&1 && git cat-file -e ${commit}^{commit} 2>&1)"; then`,
    `    printf 'harness commit %s is not in %s%s\\n' ${commit} ${shellQuote(remote)} "\${reason:+: $reason}" >&2`,
    "    exit 1",
    "  fi",
    "fi",
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

    const ran = yield* container(harnessSource(dir, remote, commit));

    return { stdout: "", stderr: ran.stderr, exitCode: ran.exitCode };
  });
}
