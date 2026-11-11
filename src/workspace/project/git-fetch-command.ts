import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import type { GitScope, RunCli } from "./git-cli.js";
import type { WorkFiles } from "./git-index-file.js";
import { fetchReport, nonFastForward, remoteBranches } from "./git-ref-report.js";
import { notARepository, unknownRemote } from "./git-remote-text.js";
import { hasUpstream, upstreamRemote } from "./git-tracking.js";
import { failure, OK } from "./git-result.js";

const NO_TRACKING = (remote: string, branch: string): GitCliResult => ({
  stdout: "",
  stderr: `There is no tracking information for the current branch.\nPlease specify which branch you want to merge with.\nSee git-pull(1) for details.\n\n    git pull <remote> <branch>\n\nIf you wish to set tracking information for this branch you can do so with:\n\n    git branch --set-upstream-to=${remote}/<branch> ${branch}\n\n`,
  exitCode: 1,
});

const VALUE_FLAGS = new Set(["--depth"]);

function positionals(args: readonly string[]): string[] {
  return args.filter(
    (arg, index) => !arg.startsWith("-") && !VALUE_FLAGS.has(args[index - 1] ?? ""),
  );
}

const LOST_REF = /Could not find|not a git repository/u;

async function isRepository(client: GitClient, dir: string): Promise<boolean> {
  try {
    await client.repoRoot({ dir });

    return true;
  } catch {
    return false;
  }
}

async function reportedFetch(
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
  files: WorkFiles,
  dir: string,
  remote: { readonly name: string; readonly url: string },
  requested: string | undefined,
): Promise<GitCliResult> {
  const before = await remoteBranches(client, files, dir, remote.name);
  const result = await cli(input);

  if (result.exitCode !== 0) return result;

  const after = await remoteBranches(client, files, dir, remote.name);
  const forced = await nonFastForward(client, dir, before, after);

  const report = fetchReport(remote.url, remote.name, {
    before,
    after,
    forced,
    requested: requested?.split(":")[0],
  });

  return { ...result, stderr: `${result.stderr}${report}` };
}

export async function fetchCommand(
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
  scope: GitScope,
  files: WorkFiles,
): Promise<GitCliResult> {
  const command = input.argv[0];
  const [remote, ref] = positionals(input.argv.slice(1));
  const dir = scope.dir;
  const remotes = await client.remoteList({ dir });
  const forwarded = { ...input, cwd: dir };

  const fetchFrom = (
    name: string,
    sent: GitCliInput,
    requested?: string,
  ): Promise<GitCliResult> => {
    const known = remotes.find((candidate) => candidate.name === name);

    return known === undefined
      ? cli(sent)
      : reportedFetch(client, cli, sent, files, dir, known, requested);
  };

  if (remote === undefined) {
    const branch = command === "pull" ? await client.currentBranch({ dir }) : undefined;

    if (remotes.length === 0 && command === "fetch") return OK;

    if (branch === undefined || (await hasUpstream(client, dir, branch))) {
      const tracked = branch === undefined ? undefined : await upstreamRemote(client, dir, branch);

      return fetchFrom(tracked ?? "origin", forwarded);
    }

    const named = remotes.find((known) => known.name === "origin") ?? remotes[0];

    const fetched =
      named === undefined
        ? OK
        : await fetchFrom(named.name, { ...input, argv: ["fetch"], cwd: dir });

    if (fetched.exitCode !== 0) return fetched;

    const missing = NO_TRACKING(named?.name ?? "<remote>", branch);

    return { ...missing, stderr: `${fetched.stderr}${missing.stderr}` };
  }

  if (unknownRemote(remotes, remote)) {
    const missing = notARepository(remote);

    return command === "pull" ? { ...missing, exitCode: 1 } : missing;
  }

  const result = await fetchFrom(remote, forwarded, ref);

  if (command !== "fetch" || ref === undefined || result.exitCode === 0) return result;

  return LOST_REF.test(result.stderr) && (await isRepository(client, dir))
    ? failure(`fatal: couldn't find remote ref ${ref.split(":")[0] ?? ref}\n`)
    : result;
}
