import type {
  DiffSummaryEntry,
  GitCliInput,
  GitCliResult,
  GitClient,
} from "@cloudflare/computer/git";
import type { RunCli } from "./git-cli.js";

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

async function summary(client: GitClient, dir: string): Promise<string> {
  const [branch, commit] = await Promise.all([
    client.currentBranch({ dir }),
    client.show({ dir, ref: "HEAD" }),
  ]);

  const parent = commit.parent[0];
  const entries = await client.diffSummary({ dir, ref: parent ?? EMPTY_TREE, to: commit.oid });
  const where = [branch ?? "detached HEAD", ...(parent === undefined ? ["(root-commit)"] : [])];
  const subject = commit.message.split("\n")[0] ?? "";

  return `[${where.join(" ")} ${commit.oid.slice(0, 7)}] ${subject}\n${changeLine(entries)}\n`;
}

export async function commitWithSummary(
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
): Promise<GitCliResult> {
  const args = input.argv.slice(1);
  const quiet = args.some((arg) => QUIET.has(arg));

  const result = await cli({
    ...input,
    argv: ["commit", ...args.filter((arg) => !IGNORED.has(arg) && !QUIET.has(arg))],
  });

  if (result.exitCode !== 0) return result;

  if (quiet) return { ...result, stdout: "" };

  return summary(client, input.cwd ?? "/").then(
    (stdout) => ({ ...result, stdout }),
    () => result,
  );
}
