import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import type { GitScope, RunCli } from "./git-cli.js";
import type { WorkFiles } from "./git-index-file.js";
import { matching, resolveSpecs, under, WILDCARD } from "./git-pathspec.js";
import { failure, OK } from "./git-result.js";
import { changeSelection, stage } from "./git-stage.js";
import { fileStatusLines } from "./git-status.js";

const NOTHING_SPECIFIED =
  "Nothing specified, nothing added.\nhint: Maybe you wanted to say 'git add .'?\nhint: Disable this message with \"git config set advice.addEmptyPathspec false\"\n";

const IGNORED_HINT =
  'hint: Use -f if you really want to add them.\nhint: Disable this message with "git config set advice.addIgnoredFile false"\n';

interface AddRequest {
  readonly update: boolean;
  readonly force: boolean;
  readonly paths: readonly string[];
}

function addRequest(args: readonly string[]): AddRequest | undefined {
  let update = false;
  let force = false;
  let literal = false;
  const paths: string[] = [];

  for (const arg of args) {
    if (literal || !arg.startsWith("-") || arg === "-") paths.push(arg);
    else if (arg === "--") literal = true;
    else if (arg === "-u" || arg === "--update") update = true;
    else if (arg === "-f" || arg === "--force") force = true;
    else return undefined;
  }

  return { update, force, paths };
}

async function exists(files: WorkFiles, dir: string, path: string): Promise<boolean> {
  try {
    await files.read(`${dir}/${path}`);

    return true;
  } catch {
    return false;
  }
}

function unmatchedFailure(typed: readonly string[], onDisk: readonly boolean[]): GitCliResult {
  const absent = onDisk.indexOf(false);

  if (absent !== -1)
    return failure(`fatal: pathspec '${typed[absent] ?? ""}' did not match any files\n`);

  return {
    stdout: "",
    stderr: typed
      .map((spec) => `error: pathspec '${spec}' did not match any file(s) known to git\n`)
      .join(""),
    exitCode: 128,
  };
}

async function present(
  files: WorkFiles,
  dir: string,
  specs: readonly string[],
): Promise<ReadonlySet<string>> {
  const everything = await files.list(dir);

  return new Set(specs.filter((spec) => everything.some((file) => under(file, spec))));
}

export async function addCommand(
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
  scope: GitScope,
  files: WorkFiles,
): Promise<GitCliResult> {
  const request = addRequest(input.argv.slice(1));

  if (request === undefined) return cli(input);

  const { update, force } = request;

  if (request.paths.length === 0 && !update) return { ...OK, stderr: NOTHING_SPECIFIED };

  const resolved = request.paths.length === 0 ? ["."] : resolveSpecs(request.paths, scope.prefix);

  if ("outside" in resolved) return failure(`fatal: '${resolved.outside}' is outside repository\n`);

  const specs = resolved;
  const lines = await fileStatusLines(client, scope.dir, files.read);
  const tracked = await client.lsFiles({ dir: scope.dir });
  const live = update ? lines.filter((line) => line.x !== "?") : lines;
  const known = [...tracked, ...live.map((line) => line.path.replace(/\/$/u, ""))];
  const worktree = force ? await files.list(scope.dir) : [];
  const universe = [...known, ...worktree];

  const missed = specs.filter((spec) => spec !== "." && matching(universe, spec).length === 0);

  const ignored: string[] = [];

  for (const spec of missed)
    if (!force && !update && !WILDCARD.test(spec) && (await exists(files, scope.dir, spec)))
      ignored.push(spec);

  const unmatched = missed.filter((spec) => !ignored.includes(spec));

  if (unmatched.length > 0) {
    const onDisk = update ? await present(files, scope.dir, unmatched) : new Set<string>();
    const typed = (spec: string): string => request.paths[specs.indexOf(spec)] ?? spec;

    return unmatchedFailure(
      unmatched.map(typed),
      unmatched.map((spec) => onDisk.has(spec)),
    );
  }

  const selection = changeSelection(live, specs);

  const changed = force
    ? [...new Set(specs.flatMap((spec) => matching(worktree, spec)))]
    : selection.changed;

  await stage(client, scope.dir, { changed, deleted: selection.deleted }, force);

  if (ignored.length === 0) return OK;

  return {
    stdout: "",
    stderr: `The following paths are ignored by one of your .gitignore files:\n${ignored.map((path) => `${path}\n`).join("")}${IGNORED_HINT}`,
    exitCode: 1,
  };
}
