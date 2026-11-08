import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import type { RunCli } from "./git-cli.js";
import { branchTracking, trackingCounts } from "./git-tracking.js";

const VERBOSITY = new Map([
  ["-v", 1],
  ["--verbose", 1],
  ["-vv", 2],
]);

async function branchLine(
  client: GitClient,
  dir: string,
  name: string,
  width: number,
  verbosity: number,
): Promise<string> {
  const [commit, tracking] = await Promise.all([
    client.show({ dir, ref: `refs/heads/${name}` }),
    branchTracking(client, dir, name),
  ]);

  const counts = tracking === undefined ? "" : trackingCounts(tracking);

  const upstream =
    tracking === undefined
      ? ""
      : verbosity > 1
        ? `[${tracking.upstream}${counts === "" ? "" : `: ${counts}`}] `
        : counts === ""
          ? ""
          : `[${counts}] `;

  const subject = commit.message.split("\n")[0] ?? "";

  return `${name.padEnd(width)} ${commit.oid.slice(0, 7)} ${upstream}${subject}`;
}

async function listVerbose(client: GitClient, dir: string, verbosity: number): Promise<string> {
  const [branches, current] = await Promise.all([
    client.branchList({ dir }),
    client.currentBranch({ dir }),
  ]);

  const sorted = branches.toSorted();
  const width = Math.max(0, ...sorted.map((name) => name.length));

  const lines = await Promise.all(
    sorted.map(async (name) => {
      const line = await branchLine(client, dir, name, width, verbosity);

      return `${name === current ? "*" : " "} ${line}\n`;
    }),
  );

  return lines.join("");
}

export function verboseBranches(
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
): Promise<GitCliResult> {
  const args = input.argv.slice(1);
  const verbosity = args.reduce((total, arg) => total + (VERBOSITY.get(arg) ?? Number.NaN), 0);

  if (args.length === 0 || Number.isNaN(verbosity)) return cli(input);

  return listVerbose(client, input.cwd ?? "/", verbosity).then(
    (stdout) => ({ stdout, stderr: "", exitCode: 0 }),
    () => cli(input),
  );
}
