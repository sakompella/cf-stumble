import type {
  DiffSummaryEntry,
  GitCliInput,
  GitCliResult,
  GitClient,
  GitDiffOptions,
} from "@cloudflare/computer/git";
import type { GitScope, RunCli } from "./git-cli.js";
import type { ReadFile } from "./git-index-file.js";
import { stagePathspecs } from "./git-commit-pathspec.js";
import { gitDate } from "./git-log-format.js";
import { statusLines, type StatusLine } from "./git-status.js";
import { headState, longStatus } from "./git-status-text.js";

const IGNORED = new Set(["--no-verify", "-n", "--no-edit"]);

const ALLOW_EMPTY_UNSUPPORTED: GitCliResult = {
  stdout: "",
  stderr: "git commit: --allow-empty is not supported\n",
  exitCode: 129,
};

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
  amend: boolean,
): Promise<string> {
  const [branch, commit] = await Promise.all([
    client.currentBranch({ dir }),
    client.show({ dir, ref: "HEAD" }),
  ]);

  const parent = commit.parent[0];
  const options: GitDiffOptions = { dir, ref: parent ?? EMPTY_TREE, to: commit.oid };

  if (paths !== undefined) options.paths = paths;

  const entries = await client.diffSummary(options);
  const root = parent === undefined && !amend;
  const where = [branch ?? "detached HEAD", ...(root ? ["(root-commit)"] : [])];

  const modes = await Promise.all(
    entries.map((entry) =>
      modeLine(client, dir, entry, entry.status === "D" ? parent : commit.oid),
    ),
  );

  const subject = commit.message.split("\n")[0] ?? "";

  return `[${where.join(" ")} ${commit.oid.slice(0, 7)}] ${subject}\n${amend ? ` Date: ${gitDate(commit.author)}\n` : ""}${changeLine(entries)}\n${modes.join("")}`;
}

async function modeLine(
  client: GitClient,
  dir: string,
  entry: DiffSummaryEntry,
  ref: string | undefined,
): Promise<string> {
  if (entry.status === "M" || ref === undefined) return "";

  const slash = entry.path.lastIndexOf("/");

  const tree = await client.lsTree(
    slash === -1 ? { dir, ref } : { dir, ref, path: entry.path.slice(0, slash) },
  );

  const item = tree.find((candidate) => candidate.path === entry.path.slice(slash + 1));

  return item === undefined
    ? ""
    : ` ${entry.status === "A" ? "create" : "delete"} mode ${item.mode} ${entry.path}\n`;
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
  readonly message: boolean;
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
  const flags = { quiet: false, amend: false, all: false, message: false };
  const pathspecs: string[] = [];
  const loose: string[] = [];
  let unknownFlag = false;
  let index = 0;

  while (index < args.length) {
    const arg = args[index++] ?? "";

    if (arg === "--") {
      pathspecs.push(...args.slice(index));
      break;
    }

    if (arg === "-m" || arg === "--message") {
      flags.message = true;
      index += 1;
    } else if (arg.startsWith("--message=")) flags.message = true;
    else if (arg === "--quiet" || arg === "-q") flags.quiet = true;
    else if (arg === "--amend") flags.amend = true;
    else if (arg === "--all" || arg === "-a") flags.all = true;
    else if (IGNORED.has(arg)) continue;
    else if (CLUSTER.test(arg)) {
      const cluster = scanCluster(arg.slice(1));

      flags.quiet = flags.quiet || cluster.quiet;
      flags.all = flags.all || cluster.all;
      flags.message = flags.message || arg.includes("m");

      if (cluster.value) index += 1;
    } else if (arg.startsWith("-")) unknownFlag = true;
    else loose.push(arg);
  }

  return { ...flags, pathspecs: unknownFlag ? pathspecs : [...loose, ...pathspecs] };
}

function forwardedArgv(args: readonly string[], pathspecs: readonly string[]): string[] {
  const forwarded: string[] = [];
  let index = 0;

  while (index < args.length) {
    const arg = args[index++] ?? "";

    if (arg === "--") return forwarded;

    if (!arg.startsWith("-") && pathspecs.includes(arg)) continue;

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

const NOTHING_TO_AMEND: GitCliResult = {
  stdout: "",
  stderr: "fatal: You have nothing to amend.\n",
  exitCode: 128,
};

async function headMessage(client: GitClient, dir: string): Promise<string | undefined> {
  try {
    return (await client.show({ dir, ref: "HEAD" })).message.replace(/\n$/u, "");
  } catch {
    return undefined;
  }
}

export async function commitWithSummary(
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
  scope: GitScope,
  readFile: ReadFile,
): Promise<GitCliResult> {
  const args = input.argv.slice(1);

  if (args.includes("--allow-empty")) return ALLOW_EMPTY_UNSUPPORTED;

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

  const initial = await statusLines(client, dir, readFile);

  if (flags.pathspecs.length > 0) {
    const refused = await stagePathspecs(client, dir, scope.prefix, flags.pathspecs, initial);

    if (refused !== undefined) return refused;
  }

  const lines = flags.pathspecs.length > 0 ? await statusLines(client, dir, readFile) : initial;
  const paths = committedPaths(lines, all);

  if (paths.length === 0 && !amend)
    return {
      stdout: longStatus(await headState(client, dir), lines, true),
      stderr: "",
      exitCode: 1,
    };

  if (all) await stageTracked(client, dir, lines);

  const reuse = amend && !flags.message;
  const previous = reuse ? await headMessage(client, dir) : undefined;

  if (reuse && previous === undefined) return NOTHING_TO_AMEND;

  const argv = [
    "commit",
    ...forwardedArgv(args, flags.pathspecs),
    ...(previous === undefined ? [] : ["-m", previous]),
  ];

  const result = await cli({ ...input, cwd: dir, argv });

  if (result.exitCode !== 0) return result;

  if (flags.quiet) return { ...result, stdout: "" };

  return summary(client, dir, amend ? undefined : paths, amend).then(
    (stdout) => ({ ...result, stdout }),
    () => result,
  );
}
