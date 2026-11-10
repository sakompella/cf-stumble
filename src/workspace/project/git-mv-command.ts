import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import type { GitScope } from "./git-cli.js";
import type { ReadFile, WorkFiles } from "./git-index-file.js";
import { rooted, under } from "./git-pathspec.js";
import { failure, OK } from "./git-result.js";
import { fileStatusLines } from "./git-status.js";

const FALL_BACK: GitCliResult = {
  stdout: "",
  stderr: "git mv: this form is not supported\n",
  exitCode: 129,
};

interface Move {
  readonly source: string;
  readonly destination: string;
  readonly directory: boolean;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");

  return cut === -1 ? "." : path.slice(0, cut);
}

function refusal(source: string, destination: string, reason: string): GitCliResult {
  return failure(`fatal: ${reason}, source=${source}, destination=${destination}\n`);
}

function renameDirectory(
  tracked: ReadonlySet<string>,
  present: readonly string[],
  source: string,
  destination: string,
): readonly Move[] | GitCliResult {
  const exists = (path: string): boolean => present.some((file) => under(file, path));

  if (!exists(source)) return refusal(source, destination, "bad source");

  if (![...tracked].some((file) => under(file, source)))
    return refusal(source, destination, "not under version control");

  if (under(destination, source))
    return refusal(source, destination, "can not move directory into itself");

  if (exists(destination)) return refusal(source, destination, "destination already exists");

  if (parentOf(destination) !== "." && !exists(parentOf(destination)))
    return failure(
      `fatal: renaming '${source}' to '${destination}' failed: No such file or directory\n`,
    );

  return [{ source, destination, directory: true }];
}

function plan(
  tracked: ReadonlySet<string>,
  present: readonly string[],
  sources: readonly string[],
  destination: string,
  trailing: boolean,
): readonly Move[] | GitCliResult {
  const exists = (path: string): boolean =>
    present.some((file) => under(file, path)) || [...tracked].some((file) => under(file, path));

  const existingDirectory = exists(destination) && !present.includes(destination);
  const [only] = sources;

  if (sources.length === 1 && only !== undefined && !present.includes(only) && !existingDirectory) {
    if (trailing && !exists(only)) return refusal(only, `${destination}/`, "bad source");

    return renameDirectory(tracked, present, only, destination);
  }

  const directory = trailing || existingDirectory;

  if (sources.length > 1 && !directory)
    return failure(`fatal: destination '${destination}' is not a directory\n`);

  if (directory && !exists(destination))
    return refusal(sources[0] ?? "", `${destination}/`, "destination directory does not exist");

  const moves: Move[] = [];

  for (const source of sources) {
    const target = directory
      ? destination === "."
        ? baseName(source)
        : `${destination}/${baseName(source)}`
      : destination;

    const isDirectory = !present.includes(source);

    if (!present.some((file) => under(file, source))) return refusal(source, target, "bad source");

    if (![...tracked].some((file) => under(file, source)))
      return refusal(source, target, "not under version control");

    if (target === source || (isDirectory && under(target, source)))
      return refusal(source, target, "can not move directory into itself");

    if (!directory && !exists(parentOf(target)))
      return refusal(source, destination, "destination directory does not exist");

    if (exists(target))
      return refusal(
        source,
        target,
        isDirectory ? "destination already exists" : "destination exists",
      );

    moves.push({ source, destination: target, directory: isDirectory });
  }

  return moves;
}

async function dirtyUnder(
  client: GitClient,
  dir: string,
  readFile: ReadFile,
  sources: readonly string[],
): Promise<boolean> {
  const lines = await fileStatusLines(client, dir, readFile);

  return lines.some(
    (line) =>
      line.x !== "?" && line.y !== " " && sources.some((source) => under(line.path, source)),
  );
}

export async function mvCommand(
  client: GitClient,
  input: GitCliInput,
  scope: GitScope,
  files: WorkFiles,
): Promise<GitCliResult> {
  const args = input.argv.slice(1);

  if (args.some((arg) => arg.startsWith("-")) || args.length < 2) return FALL_BACK;

  const roots = args.map((arg) => rooted(arg, scope.prefix));

  const outside = roots.findIndex((root) => root === undefined);

  if (outside !== -1)
    return failure(`fatal: '${args[outside] ?? ""}' is outside repository at '${scope.dir}'\n`);

  const paths = roots.map((root) => root ?? ".");
  const destination = paths.pop() ?? ".";
  const trailing = (args.at(-1) ?? "").endsWith("/");
  const present = await files.list(scope.dir);
  const tracked = new Set(await client.lsFiles({ dir: scope.dir }));
  const moves = plan(tracked, present, paths, destination, trailing);

  if ("exitCode" in moves) return moves;

  if (await dirtyUnder(client, scope.dir, files.read, paths)) return FALL_BACK;

  for (const move of moves) {
    const moved = present.filter((file) => under(file, move.source));
    const staged = [...tracked].filter((file) => under(file, move.source));
    const rename = (file: string): string => `${move.destination}${file.slice(move.source.length)}`;

    for (const file of moved)
      await files.rename(`${scope.dir}/${file}`, `${scope.dir}/${rename(file)}`, scope.dir);

    await client.rm({ dir: scope.dir, paths: staged });
    await client.add({ dir: scope.dir, paths: staged.map(rename) });
  }

  return OK;
}
