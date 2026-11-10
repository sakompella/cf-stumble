import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import type { GitScope } from "./git-cli.js";
import type { ReadFile } from "./git-index-file.js";
import { rooted, under } from "./git-pathspec.js";
import { failure, OK, pathspecError } from "./git-result.js";
import { resolves } from "./git-revision.js";
import { statusLines, type StatusLine } from "./git-status.js";

const RESTORE_USAGE =
  "usage: git restore [--source <tree-ish>] [--staged] [--worktree] [--] <pathspec>...\n";

interface RestoreRequest {
  readonly staged: boolean;
  readonly worktree: boolean;
  readonly source: string | undefined;
  readonly paths: readonly string[];
  readonly unsupported: string | undefined;
}

function restoreRequest(args: readonly string[]): RestoreRequest {
  let staged = false;
  let worktree = false;
  let source: string | undefined;
  let unsupported: string | undefined;
  const paths: string[] = [];
  let index = 0;

  while (index < args.length) {
    const arg = args[index++] ?? "";

    if (arg === "--") {
      paths.push(...args.slice(index));

      return { staged, worktree: staged ? worktree : true, source, paths, unsupported };
    }

    if (arg === "--staged" || arg === "-S") staged = true;
    else if (arg === "--worktree" || arg === "-W") worktree = true;
    else if (arg === "--source" || arg === "-s") source = args[index++];
    else if (arg.startsWith("--source=")) source = arg.slice("--source=".length);
    else if (arg.startsWith("-")) unsupported = arg;
    else paths.push(arg);
  }

  return { staged, worktree: staged ? worktree : true, source, paths, unsupported };
}

function restoreSelection(candidates: readonly string[], specs: readonly string[]) {
  const matched = candidates.filter((path) => specs.some((spec) => under(path, spec)));

  return { matched, missed: specs.filter((spec) => !matched.some((path) => under(path, spec))) };
}

async function restoreIndex(
  client: GitClient,
  dir: string,
  source: string | undefined,
  matched: readonly string[],
): Promise<void> {
  await client.reset(
    source === undefined ? { dir, paths: [...matched] } : { dir, paths: [...matched], ref: source },
  );
}

async function restoreWorktree(
  client: GitClient,
  dir: string,
  source: string | undefined,
  matched: readonly string[],
  changed: readonly StatusLine[],
): Promise<GitCliResult> {
  const stagedPaths = changed.filter((line) => matched.includes(line.path));
  const dirty = stagedPaths.filter((line) => line.y !== " ");

  if (dirty.length > 0 || (source !== undefined && stagedPaths.length > 0)) {
    const path = (dirty[0] ?? stagedPaths[0])?.path ?? "";

    return failure(
      `error: path '${path}' has staged changes; restoring its working tree is not supported by this git; unstage or commit it first\n`,
    );
  }

  const restorable =
    source === undefined
      ? matched.filter((path) => !stagedPaths.some((line) => line.path === path))
      : matched;

  if (restorable.length === 0) return OK;

  if (source === undefined) {
    await client.checkout({ dir, ref: "HEAD", paths: [...restorable], force: true });

    return OK;
  }

  const head = await resolves(client, dir, "HEAD");

  await client.checkout({ dir, ref: source, paths: [...restorable], force: true });
  await client.reset(
    head === undefined
      ? { dir, paths: [...restorable] }
      : { dir, paths: [...restorable], ref: head },
  );

  return OK;
}

export async function restoreCommand(
  client: GitClient,
  input: GitCliInput,
  scope: GitScope,
  readFile: ReadFile,
): Promise<GitCliResult> {
  const request = restoreRequest(input.argv.slice(1));
  const dir = scope.dir;

  if (request.unsupported !== undefined)
    return {
      stdout: "",
      stderr: `error: unsupported option '${request.unsupported}'\n${RESTORE_USAGE}`,
      exitCode: 129,
    };

  if (request.paths.length === 0) return failure("fatal: you must specify path(s) to restore\n");

  const source =
    request.source === undefined ? undefined : await resolves(client, dir, request.source);

  if (request.source !== undefined && source === undefined)
    return failure(`fatal: ambiguous argument '${request.source}': unknown revision or path\n`);

  const specs: string[] = [];

  for (const path of request.paths) {
    const at = rooted(path, scope.prefix);

    if (at === undefined) return failure(`fatal: '${path}' is outside repository\n`);

    specs.push(at);
  }

  const tracked = await client.lsFiles({ dir });

  const changed = (await statusLines(client, dir, readFile)).filter(
    (line) => line.x !== " " && line.x !== "?",
  );

  const candidates =
    request.worktree && !request.staged
      ? tracked
      : [...new Set([...tracked, ...changed.map((line) => line.path)])];

  const { matched, missed } = restoreSelection(candidates, specs);

  if (missed.length > 0) return pathspecError(missed);

  if (matched.length === 0) return OK;

  if (!request.worktree) {
    await restoreIndex(client, dir, source, matched);

    return OK;
  }

  if (request.staged) {
    await client.checkout({ dir, ref: source ?? "HEAD", paths: [...matched], force: true });

    return OK;
  }

  return restoreWorktree(client, dir, source, matched, changed);
}
