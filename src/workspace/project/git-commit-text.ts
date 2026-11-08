import type {
  DiffSummaryEntry,
  GitCliInput,
  GitCliResult,
  GitClient,
  GitDiffOptions,
} from "@cloudflare/computer/git";
import type { RunCli } from "./git-cli.js";
import { statusLines, type StatusLine } from "./git-status.js";
import { headState, longStatus } from "./git-status-text.js";

const IGNORED = new Set(["--no-verify", "-n"]);

const QUIET = new Set(["-q", "--quiet"]);

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

function changeLine(entries: readonly DiffSummaryEntry[]): string {
  const insertions = entries.reduce((total, entry) => total + entry.insertions, 0);
  const deletions = entries.reduce((total, entry) => total + entry.deletions, 0);

  const parts = [
    plural(entries.length, "file changed", "files changed"),
    ...(insertions > 0 || deletions === 0
      ? [plural(insertions, "insertion(+)", "insertions(+)")]
      : []),
    ...(deletions > 0 || insertions === 0
      ? [plural(deletions, "deletion(-)", "deletions(-)")]
      : []),
  ];

  return ` ${parts.join(", ")}`;
}

async function summary(
  client: GitClient,
  dir: string,
  paths: string[] | undefined,
): Promise<string> {
  const [branch, commit] = await Promise.all([
    client.currentBranch({ dir }),
    client.show({ dir, ref: "HEAD" }),
  ]);

  const parent = commit.parent[0];
  const options: GitDiffOptions = { dir, ref: parent ?? EMPTY_TREE, to: commit.oid };

  if (paths !== undefined) options.paths = paths;

  const entries = await client.diffSummary(options);
  const where = [branch ?? "detached HEAD", ...(parent === undefined ? ["(root-commit)"] : [])];

  const subject = commit.message.split("\n")[0] ?? "";

  return `[${where.join(" ")} ${commit.oid.slice(0, 7)}] ${subject}\n${changeLine(entries)}\n`;
}

function committedPaths(lines: readonly StatusLine[], all: boolean): string[] {
  return lines.flatMap((line) =>
    line.x !== "?" && (line.x !== " " || (all && line.y !== " ")) ? [line.path] : [],
  );
}

async function stageTracked(client: GitClient, dir: string, lines: readonly StatusLine[]) {
  const unstaged = lines.filter((line) => line.x !== "?" && line.y !== " ");
  const modified = unstaged.flatMap((line) => (line.y === "D" ? [] : [line.path]));
  const deleted = unstaged.flatMap((line) => (line.y === "D" ? [line.path] : []));

  if (modified.length > 0) await client.add({ dir, paths: modified });

  if (deleted.length > 0) await client.rm({ dir, paths: deleted });
}

function withoutAll(arg: string): string[] {
  if (arg === "-a" || arg === "--all") return [];

  return /^-a+m$/u.test(arg) ? ["-m"] : [arg];
}

export async function commitWithSummary(
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
): Promise<GitCliResult> {
  const args = input.argv.slice(1);
  const quiet = args.some((arg) => QUIET.has(arg));
  const dir = input.cwd ?? "/";
  const amend = args.includes("--amend");
  const all = args.some((arg) => withoutAll(arg).length === 0 || /^-a+m$/u.test(arg));
  const lines = await statusLines(client, dir);
  const paths = committedPaths(lines, all);

  if (paths.length === 0 && !amend)
    return { stdout: longStatus(await headState(client, dir), lines), stderr: "", exitCode: 1 };

  if (all) await stageTracked(client, dir, lines);

  const result = await cli({
    ...input,
    argv: [
      "commit",
      ...args.filter((arg) => !IGNORED.has(arg) && !QUIET.has(arg)).flatMap(withoutAll),
    ],
  });

  if (result.exitCode !== 0) return result;

  if (quiet) return { ...result, stdout: "" };

  return summary(client, dir, amend ? undefined : paths).then(
    (stdout) => ({ ...result, stdout }),
    () => result,
  );
}
