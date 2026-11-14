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

type Git = Pick<
  Workspace["git"],
  "clone" | "configSet" | "configGet" | "show" | "fetch" | "revParse" | "currentBranch" | "log"
>;

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

function fastForwardSource(dir: string, branch: string): string {
  return [
    "set -eu",
    `cd ${shellQuote(dir)}`,
    'head="$(git rev-parse --short=7 HEAD)"',
    "if ! git diff --quiet HEAD --; then",
    `  printf 'harness checkout has local changes; left at %s\\n' "$head" >&2`,
    `elif ! git merge --ff-only --quiet ${shellQuote(`origin/${branch}`)} >/dev/null 2>&1; then`,
    `  printf 'harness checkout not updated: cannot fast-forward from %s\\n' "$head" >&2`,
    "fi",
  ].join("\n");
}

type Advance = Readonly<{ message: string }> | Readonly<{ fastForward: string }>;

async function reaches(git: Git, dir: string, from: string, to: string): Promise<boolean> {
  const recent = await git.log({ dir, ref: from, depth: HARNESS_CLONE_DEPTH });

  return recent.some((commit) => commit.oid === to);
}

async function advanceNeeded(git: Git, dir: string): Promise<Advance> {
  const head = await git.revParse({ dir, ref: "HEAD" });
  const branch = await git.currentBranch({ dir });

  const stuck = {
    message: `harness checkout not updated: cannot fast-forward from ${head.slice(0, 7)}\n`,
  };

  if (branch === undefined) return stuck;

  try {
    await git.fetch({ dir, remote: "origin", singleBranch: true, tags: false });
  } catch {
    return { message: "harness checkout not updated: fetch failed\n" };
  }

  const upstream = await git.revParse({ dir, ref: `origin/${branch}` });

  if (await reaches(git, dir, head, upstream)) return { message: "" };

  return (await reaches(git, dir, upstream, head)) ? { fastForward: branch } : stuck;
}

function advanceCheckout(
  git: Git,
  dir: string,
  container: Container,
): Effect.Effect<string, WorkspaceFault> {
  return attemptWorkspace(() => advanceNeeded(git, dir)).pipe(
    Effect.flatMap((advance) =>
      "message" in advance
        ? Effect.succeed(advance.message)
        : container(fastForwardSource(dir, advance.fastForward)).pipe(
            Effect.map((output) => output.stderr),
          ),
    ),
  );
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

    return { stdout: "", stderr: yield* advanceCheckout(git, dir, container), exitCode: 0 };
  });
}
