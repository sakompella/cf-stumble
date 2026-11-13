import type { Workspace } from "@cloudflare/computer";
import * as Effect from "effect/Effect";
import type { HarnessBuildConfiguration } from "../harness-build.js";
import type { HarnessCommit } from "../harness-commit.js";
import { hasErrnoCode } from "./errno-code.js";
import { cloneIntoPlace, githubToken } from "./isolate-clone.js";
import { attemptWorkspace, type CommandOutput, type WorkspaceFault } from "./operations.js";

const HARNESS_CLONE_DEPTH = 50;

const HARNESS_DEEPEN_DEPTHS = [500, 5_000, 100_000] as const;

type Git = Pick<
  Workspace["git"],
  | "clone"
  | "configSet"
  | "configGet"
  | "show"
  | "fetch"
  | "revParse"
  | "status"
  | "currentBranch"
  | "merge"
  | "checkout"
>;

type HarnessWorkspace = Readonly<{
  fs: Pick<Workspace["fs"], "readFile" | "readdir" | "stat" | "rm" | "mkdir" | "rename">;
  git: Git;
}>;

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

async function obtainCommit(git: Git, dir: string, commit: HarnessCommit): Promise<boolean> {
  for (const depth of HARNESS_DEEPEN_DEPTHS) {
    if (await hasCommit(git, dir, commit)) return true;

    await git.fetch({ dir, remote: "origin", depth, singleBranch: true, tags: false });
  }

  if (await hasCommit(git, dir, commit)) return true;

  await git.fetch({
    dir,
    remote: "origin",
    depth: HARNESS_CLONE_DEPTH,
    singleBranch: false,
    tags: false,
  });

  return hasCommit(git, dir, commit);
}

async function advanceCheckout(git: Git, dir: string): Promise<string> {
  const head = (await git.revParse({ dir, ref: "HEAD" })).slice(0, 7);
  const changes = await git.status({ dir });

  if (changes.some((entry) => entry.worktree !== "?")) {
    return `harness checkout has local changes; left at ${head}\n`;
  }

  const branch = await git.currentBranch({ dir });

  try {
    await git.fetch({ dir, remote: "origin", singleBranch: true, tags: false });
  } catch {
    return "harness checkout not updated: fetch failed\n";
  }

  const stuck = `harness checkout not updated: cannot fast-forward from ${head}\n`;

  if (branch === undefined) return stuck;

  try {
    await git.merge({ dir, theirs: `origin/${branch}`, fastForwardOnly: true });
    await git.checkout({ dir, ref: branch });
  } catch {
    return stuck;
  }

  return "";
}

export function provisionHarness(
  workspace: HarnessWorkspace,
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

    if (!(yield* attemptWorkspace(() => obtainCommit(git, dir, commit)))) {
      return failed(`harness commit ${commit} is not in ${remote}`);
    }

    return {
      stdout: "",
      stderr: yield* attemptWorkspace(() => advanceCheckout(git, dir)),
      exitCode: 0,
    };
  });
}
