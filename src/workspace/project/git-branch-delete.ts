import type { GitCliResult, GitClient } from "@cloudflare/computer/git";
import { failure } from "./git-result.js";
import { resolves } from "./git-revision.js";
import { upstreamRef } from "./git-tracking.js";

const SHORT_FLAGS = /^-[dDfq]+$/u;

const LONG_FLAGS = new Map([
  ["--delete", "d"],
  ["--force", "f"],
  ["--quiet", "q"],
]);

interface Deletion {
  readonly names: readonly string[];
  readonly force: boolean;
  readonly quiet: boolean;
}

function flagLetters(arg: string): readonly string[] | undefined {
  if (arg.startsWith("--")) {
    const letter = LONG_FLAGS.get(arg);

    return letter === undefined ? undefined : [letter];
  }

  return SHORT_FLAGS.test(arg) ? arg.slice(1).split("") : undefined;
}

export function deletionRequest(args: readonly string[]): Deletion | undefined {
  const flags: string[] = [];
  const names: string[] = [];

  for (const arg of args) {
    if (!arg.startsWith("-") || arg === "-") names.push(arg);
    else {
      const letters = flagLetters(arg);

      if (letters === undefined) return undefined;

      flags.push(...letters);
    }
  }

  if (!flags.includes("d") && !flags.includes("D")) return undefined;

  return { names, force: flags.includes("D") || flags.includes("f"), quiet: flags.includes("q") };
}

const NOT_MERGED_HINT = (name: string): string =>
  `hint: If you are sure you want to delete it, run 'git branch -D ${name}'\nhint: Disable this message with "git config set advice.forceDeleteBranch false"\n`;

async function reachable(
  client: GitClient,
  dir: string,
  from: string | undefined,
  tip: string,
): Promise<boolean> {
  if (from === undefined) return false;

  const history = await client.log({ dir, ref: from });

  return history.some((commit) => commit.oid === tip);
}

interface Verdict {
  readonly merged: boolean;
  readonly warning: string;
}

async function mergeVerdict(
  client: GitClient,
  dir: string,
  name: string,
  tip: string,
): Promise<Verdict> {
  const upstream = await upstreamRef(client, dir, name);
  const upstreamTip = upstream === undefined ? undefined : await resolves(client, dir, upstream);
  const head = await resolves(client, dir, "HEAD");
  const intoHead = await reachable(client, dir, head, tip);

  if (upstream === undefined || upstreamTip === undefined) return { merged: intoHead, warning: "" };

  const merged = await reachable(client, dir, upstreamTip, tip);

  if (merged === intoHead || upstreamTip === head) return { merged, warning: "" };

  const warning = merged
    ? `warning: deleting branch '${name}' that has been merged to\n         '${upstream}', but not yet merged to HEAD\n`
    : `warning: not deleting branch '${name}' that is not yet merged to\n         '${upstream}', even though it is merged to HEAD\n`;

  return { merged, warning };
}

function refused(stderr: string): GitCliResult {
  return { stdout: "", stderr, exitCode: 1 };
}

async function deleteOne(
  client: GitClient,
  dir: string,
  name: string,
  request: Deletion,
): Promise<GitCliResult> {
  if ((await client.currentBranch({ dir })) === name)
    return refused(`error: cannot delete branch '${name}' used by worktree at '${dir}'\n`);

  const tip = await resolves(client, dir, `refs/heads/${name}`);

  if (tip === undefined) return refused(`error: branch '${name}' not found\n`);

  const verdict = request.force
    ? { merged: true, warning: "" }
    : await mergeVerdict(client, dir, name, tip);

  if (!verdict.merged)
    return refused(
      `${verdict.warning}error: the branch '${name}' is not fully merged\n${NOT_MERGED_HINT(name)}`,
    );

  return deleted(client, dir, name, tip, request, verdict.warning);
}

async function deleted(
  client: GitClient,
  dir: string,
  name: string,
  tip: string,
  request: Deletion,
  warning: string,
): Promise<GitCliResult> {
  await client.branchDelete({ dir, name });

  return {
    stdout: request.quiet ? "" : `Deleted branch ${name} (was ${tip.slice(0, 7)}).\n`,
    stderr: warning,
    exitCode: 0,
  };
}

export async function deleteBranches(
  client: GitClient,
  dir: string,
  request: Deletion,
): Promise<GitCliResult> {
  if (request.names.length === 0) return failure("fatal: branch name required\n");

  const results: GitCliResult[] = [];

  for (const name of request.names) results.push(await deleteOne(client, dir, name, request));

  return {
    stdout: results.map((result) => result.stdout).join(""),
    stderr: results.map((result) => result.stderr).join(""),
    exitCode: results.some((result) => result.exitCode !== 0) ? 1 : 0,
  };
}
