import type { CommitView, GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import { createBranch, creationRequest } from "./git-branch-create.js";
import { deleteBranches, deletionRequest } from "./git-branch-delete.js";
import type { GitScope, RunCli } from "./git-cli.js";
import { reportingFailure } from "./git-result.js";
import { branchTracking, trackingCounts, type Tracking } from "./git-tracking.js";

const VERBOSITY = new Map([
  ["-v", 1],
  ["--verbose", 1],
  ["-vv", 2],
]);

interface Row {
  readonly name: string;
  readonly current: boolean;
  readonly details: () => Promise<[CommitView, Tracking | undefined]>;
}

function upstreamText(tracking: Tracking | undefined, verbosity: number): string {
  if (tracking === undefined) return "";

  const counts = trackingCounts(tracking);

  if (verbosity > 1) return `[${tracking.upstream}${counts === "" ? "" : `: ${counts}`}] `;

  return counts === "" ? "" : `[${counts}] `;
}

async function rowLine(row: Row, width: number, verbosity: number): Promise<string> {
  const marker = row.current ? "*" : " ";

  if (verbosity === 0) return `${marker} ${row.name}\n`;

  const [commit, tracking] = await row.details();
  const subject = commit.message.split("\n")[0] ?? "";

  return `${marker} ${row.name.padEnd(width)} ${commit.oid.slice(0, 7)} ${upstreamText(tracking, verbosity)}${subject}\n`;
}

async function listBranches(client: GitClient, dir: string, verbosity: number): Promise<string> {
  const [branches, current] = await Promise.all([
    client.branchList({ dir }),
    client.currentBranch({ dir }),
  ]);

  const head = current === undefined ? await client.show({ dir, ref: "HEAD" }) : undefined;

  const detached: Row[] =
    head === undefined
      ? []
      : [
          {
            name: `(HEAD detached at ${head.oid.slice(0, 7)})`,
            current: true,
            details: () => Promise.resolve([head, undefined]),
          },
        ];

  const rows = [
    ...detached,
    ...branches.toSorted().map((name): Row => ({
      name,
      current: name === current,
      details: () =>
        Promise.all([
          client.show({ dir, ref: `refs/heads/${name}` }),
          branchTracking(client, dir, name),
        ]),
    })),
  ];

  const width = Math.max(0, ...rows.map((row) => row.name.length));
  const lines = await Promise.all(rows.map((row) => rowLine(row, width, verbosity)));

  return lines.join("");
}

export function verboseBranches(
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
  scope: GitScope,
): Promise<GitCliResult> {
  const args = input.argv.slice(1);
  const deletion = deletionRequest(args);

  if (deletion !== undefined)
    return reportingFailure(() => deleteBranches(client, scope.dir, deletion));

  const creation = creationRequest(args);

  if (creation !== undefined)
    return reportingFailure(() => createBranch(client, scope.dir, creation));

  const verbosity = args.reduce((total, arg) => total + (VERBOSITY.get(arg) ?? Number.NaN), 0);

  if (Number.isNaN(verbosity)) return cli({ ...input, cwd: scope.dir });

  return listBranches(client, scope.dir, verbosity).then(
    (stdout) => ({ stdout, stderr: "", exitCode: 0 }),
    () => cli({ ...input, cwd: scope.dir }),
  );
}
