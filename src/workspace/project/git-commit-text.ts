import type {
  DiffSummaryEntry,
  GitCliInput,
  GitCliResult,
  GitClient,
  GitDiffOptions,
} from "@cloudflare/computer/git";
import type { GitScope, RunCli } from "./git-cli.js";
import { statusLines, type StatusLine } from "./git-status.js";
import { headState, longStatus } from "./git-status-text.js";

const IGNORED = new Set(["--no-verify", "-n"]);

const QUIET = new Set(["-q", "--quiet"]);

const CLUSTER = /^-[aqnm]+$/u;

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

interface CommitFlags {
  readonly quiet: boolean;
  readonly amend: boolean;
  readonly all: boolean;
  readonly pathspecs: readonly string[];
}

interface ClusterFlags {
  readonly quiet: boolean;
  readonly all: boolean;
  readonly value: boolean;
}

function scanCluster(cluster: string): ClusterFlags {
  const at = cluster.indexOf("m");

  if (at === -1) return { quiet: cluster.includes("q"), all: cluster.includes("a"), value: false };

  return {
    quiet: cluster.slice(0, at).includes("q"),
    all: cluster.slice(0, at).includes("a"),
    value: at === cluster.length - 1,
  };
}

function scanCommit(args: readonly string[]): CommitFlags {
  let quiet = false;
  let amend = false;
  let all = false;
  const pathspecs: string[] = [];
  let index = 0;

  while (index < args.length) {
    const arg = args[index++] ?? "";

    if (arg === "--") {
      pathspecs.push(...args.slice(index));
      break;
    }

    if (arg === "-m" || arg === "--message") {
      index += 1;
      continue;
    }

    if (arg.startsWith("--message=")) continue;

    if (arg === "--quiet" || arg === "-q") {
      quiet = true;

      continue;
    }

    if (arg === "--amend") {
      amend = true;

      continue;
    }

    if (arg === "--all" || arg === "-a") {
      all = true;

      continue;
    }

    if (IGNORED.has(arg)) continue;

    if (CLUSTER.test(arg)) {
      const flags = scanCluster(arg.slice(1));

      quiet = quiet || flags.quiet;
      all = all || flags.all;

      if (flags.value) index += 1;

      continue;
    }

    pathspecs.push(arg);
  }

  return { quiet, amend, all, pathspecs };
}

function forwardedArgv(args: readonly string[]): string[] {
  const forwarded: string[] = [];
  let index = 0;

  while (index < args.length) {
    const arg = args[index++] ?? "";

    if (arg === "--") {
      forwarded.push(...args.slice(index - 1));

      return forwarded;
    }

    if (arg === "-m" || arg === "--message") {
      forwarded.push(arg, args[index++] ?? "");
      continue;
    }

    if (arg.startsWith("--message=")) {
      forwarded.push(arg);
      continue;
    }

    if (QUIET.has(arg) || IGNORED.has(arg) || arg === "--all" || arg === "-a") continue;

    if (CLUSTER.test(arg)) {
      const cluster = arg.slice(1);
      const message = cluster.indexOf("m");
      const head = (message === -1 ? cluster : cluster.slice(0, message)).replaceAll(/[aqn]/gu, "");
      const kept = `${head}${message === -1 ? "" : cluster.slice(message)}`;

      if (kept.length > 0) forwarded.push(`-${kept}`);
      continue;
    }

    forwarded.push(arg);
  }

  return forwarded;
}

export async function commitWithSummary(
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
  scope: GitScope,
): Promise<GitCliResult> {
  const args = input.argv.slice(1);
  const flags = scanCommit(args);
  const dir = scope.dir;
  const amend = flags.amend;
  const all = flags.all;

  if (scope.prefix !== "" && flags.pathspecs.length > 0)
    return {
      stdout: "",
      stderr: "fatal: pathspec arguments are not supported from a subdirectory\n",
      exitCode: 128,
    };

  const lines = await statusLines(client, dir);
  const paths = committedPaths(lines, all);

  if (paths.length === 0 && !amend)
    return { stdout: longStatus(await headState(client, dir), lines), stderr: "", exitCode: 1 };

  if (all) await stageTracked(client, dir, lines);

  const result = await cli({ ...input, cwd: dir, argv: ["commit", ...forwardedArgv(args)] });

  if (result.exitCode !== 0) return result;

  if (flags.quiet) return { ...result, stdout: "" };

  return summary(client, dir, amend ? undefined : paths).then(
    (stdout) => ({ ...result, stdout }),
    () => result,
  );
}
