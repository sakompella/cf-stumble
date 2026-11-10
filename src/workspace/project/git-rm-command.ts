import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import type { GitScope } from "./git-cli.js";
import { failure, rooted, under } from "./git-index-commands.js";
import { statusLines, type StatusLine } from "./git-status.js";

export type RemoveFile = (path: string, stop: string) => Promise<void>;

const USAGE = "usage: git rm [<options>] [--] <file>...\n";

const SHORT_FLAGS = new Map([
  ["r", "recursive"],
  ["f", "force"],
  ["q", "quiet"],
]);

const LONG_FLAGS = new Map([
  ["--cached", "cached"],
  ["--force", "force"],
  ["--quiet", "quiet"],
]);

interface RmRequest {
  readonly flags: ReadonlySet<string>;
  readonly paths: readonly string[];
  readonly unknown: string | undefined;
}

function rmRequest(args: readonly string[]): RmRequest {
  const flags = new Set<string>();
  const paths: string[] = [];
  let unknown: string | undefined;
  let literal = false;

  for (const arg of args) {
    const long = LONG_FLAGS.get(arg);

    if (literal || !arg.startsWith("-") || arg === "-") paths.push(arg);
    else if (arg === "--") literal = true;
    else if (long !== undefined) flags.add(long);
    else if (
      !arg.startsWith("--") &&
      arg
        .slice(1)
        .split("")
        .every((flag) => SHORT_FLAGS.has(flag))
    )
      for (const flag of arg.slice(1)) flags.add(SHORT_FLAGS.get(flag) ?? "");
    else unknown ??= arg;
  }

  return { flags, paths, unknown };
}

function listed(paths: readonly string[], singular: string, plural: string, hint: string): string {
  const noun = paths.length === 1 ? singular : plural;

  return `error: the following ${noun}:\n${paths.map((path) => `    ${path}\n`).join("")}${hint}\n`;
}

function staged(line: StatusLine): boolean {
  return line.x === "M" || line.x === "A";
}

function refusal(lines: readonly StatusLine[], cached: boolean): string {
  const names = (keep: (line: StatusLine) => boolean): string[] =>
    lines.flatMap((line) => (keep(line) ? [line.path] : []));

  const both = names((line) => staged(line) && line.y === "M");
  const modified = names((line) => !staged(line) && line.y === "M");
  const indexed = names((line) => staged(line) && line.y === " ");

  return [
    both.length === 0
      ? ""
      : listed(
          both,
          "file has staged content different from both the\nfile and the HEAD",
          "files have staged content different from both the\nfile and the HEAD",
          "(use -f to force removal)",
        ),
    cached || modified.length === 0
      ? ""
      : listed(
          modified,
          "file has local modifications",
          "files have local modifications",
          "(use --cached to keep the file, or -f to force removal)",
        ),
    cached || indexed.length === 0
      ? ""
      : listed(
          indexed,
          "file has changes staged in the index",
          "files have changes staged in the index",
          "(use --cached to keep the file, or -f to force removal)",
        ),
  ].join("");
}

export async function rmCommand(
  client: GitClient,
  input: GitCliInput,
  scope: GitScope,
  removeFile: RemoveFile,
): Promise<GitCliResult> {
  const request = rmRequest(input.argv.slice(1));
  const { flags } = request;

  if (request.unknown !== undefined)
    return {
      stdout: "",
      stderr: `error: unknown switch \`${request.unknown.replace(/^-+/u, "")}'\n${USAGE}`,
      exitCode: 129,
    };

  if (request.paths.length === 0) return { stdout: "", stderr: USAGE, exitCode: 129 };

  const tracked = await client.lsFiles({ dir: scope.dir });
  const removed = new Set<string>();

  for (const path of request.paths) {
    const at = rooted(path, scope.prefix);

    if (at === undefined) return failure(`fatal: '${path}' is outside repository\n`);

    const matches = tracked.filter((file) => under(file, at));

    if (matches.length === 0) return failure(`fatal: pathspec '${path}' did not match any files\n`);

    if (!flags.has("recursive") && matches.some((file) => file !== at))
      return failure(`fatal: not removing '${path}' recursively without -r\n`);

    for (const file of matches) removed.add(file);
  }

  const lines = (await statusLines(client, scope.dir)).filter((line) => removed.has(line.path));
  const refused = flags.has("force") ? "" : refusal(lines, flags.has("cached"));

  if (refused !== "") return { stdout: "", stderr: refused, exitCode: 1 };

  const paths = tracked.filter((file) => removed.has(file));
  const gone = new Set(lines.filter((line) => line.y === "D").map((line) => line.path));

  await client.rm({ dir: scope.dir, paths });

  if (!flags.has("cached"))
    for (const path of paths)
      if (!gone.has(path)) await removeFile(`${scope.dir}/${path}`, scope.dir);

  return {
    stdout: flags.has("quiet") ? "" : paths.map((path) => `rm '${path}'\n`).join(""),
    stderr: "",
    exitCode: 0,
  };
}
