import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import type { GitScope, RunCli } from "./git-cli.js";
import { fileStatusLines, statusLines, type StatusLine } from "./git-status.js";

const OK: GitCliResult = { stdout: "", stderr: "", exitCode: 0 };

export function failure(stderr: string): GitCliResult {
  return { stdout: "", stderr, exitCode: 128 };
}

function without(argv: readonly string[], flags: readonly string[]): string[] {
  return argv.filter((arg) => !flags.includes(arg));
}

export function rooted(path: string, prefix: string): string | undefined {
  const parts = prefix.split("/").filter((part) => part !== "");
  let rest = path.startsWith("./") ? path.slice(2) : path;

  if (rest === ".") rest = "";

  for (const part of rest.split("/")) {
    if (part === "" || part === ".") continue;

    if (part === "..") {
      if (parts.pop() === undefined) return undefined;

      continue;
    }

    parts.push(part);
  }

  return parts.length === 0 ? "." : parts.join("/");
}

export function under(path: string, spec: string): boolean {
  const bare = spec.replace(/\/$/u, "");

  return bare === "." || path === bare || path.startsWith(`${bare}/`) || path === `${bare}/`;
}

async function stage(
  client: GitClient,
  dir: string,
  lines: readonly { readonly path: string; readonly y: string }[],
): Promise<void> {
  const pending = lines.filter((line) => line.y !== " ");

  const changed = pending.flatMap((line) =>
    line.y === "D" ? [] : [line.path.replace(/\/$/u, "")],
  );

  const deleted = pending.flatMap((line) => (line.y === "D" ? [line.path] : []));

  if (changed.length > 0) await client.add({ dir, paths: changed });

  if (deleted.length > 0) await client.rm({ dir, paths: deleted });
}

export async function addCommand(
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
  scope: GitScope,
): Promise<GitCliResult> {
  const args = input.argv.slice(1);
  const rest = without(args, ["-u", "--update"]);

  if (rest.length === args.length || rest.some((arg) => arg !== ".")) {
    if (args.some((arg) => arg.startsWith("-"))) return cli(input);

    const specs: string[] = [];

    for (const path of rest) {
      const at = rooted(path, scope.prefix);

      if (at === undefined) return failure(`fatal: '${path}' is outside repository\n`);

      specs.push(at);
    }

    const lines = await fileStatusLines(client, scope.dir);
    const matched = lines.filter((line) => specs.some((spec) => under(line.path, spec)));

    const missed = specs.find(
      (spec) => spec !== "." && !matched.some((line) => under(line.path, spec)),
    );

    if (missed !== undefined)
      return failure(`fatal: pathspec '${missed}' did not match any files\n`);

    await stage(client, scope.dir, matched);

    return OK;
  }

  const tracked = (await statusLines(client, scope.dir)).filter(
    (line) => line.x !== "?" && line.y !== " ",
  );

  await stage(client, scope.dir, tracked);

  return OK;
}

async function moveHead(client: GitClient, dir: string, oid: string): Promise<void> {
  const branch = await client.currentBranch({ dir });

  await client.updateRef({
    dir,
    ref: branch === undefined ? "HEAD" : `refs/heads/${branch}`,
    value: oid,
    force: true,
  });
}

async function resolves(client: GitClient, dir: string, ref: string): Promise<string | undefined> {
  try {
    return await client.revParse({ dir, ref });
  } catch {
    return undefined;
  }
}

async function resetReport(client: GitClient, dir: string, hard: boolean): Promise<string> {
  if (hard) {
    const head = await client.show({ dir, ref: "HEAD" });

    return `HEAD is now at ${head.oid.slice(0, 7)} ${head.message.split("\n")[0] ?? ""}\n`;
  }

  const unstaged = (await statusLines(client, dir)).filter(
    (line) => line.x !== "?" && line.y !== " ",
  );

  return unstaged.length === 0
    ? ""
    : `Unstaged changes after reset:\n${unstaged.map((line) => `${line.y}\t${line.path}\n`).join("")}`;
}

const REVISION_SYNTAX = /[~^@]/u;

const AMBIGUOUS = (target: string): string =>
  `fatal: ambiguous argument '${target}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'\n`;

async function resetWithoutReport(
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
  scope: GitScope,
  args: readonly string[],
): Promise<GitCliResult> {
  const soft = args.includes("--soft");
  const mixed = args.includes("--mixed");
  const rest = without(args, ["--soft", "--mixed", "-q", "--quiet"]);
  const dir = scope.dir;

  if (args.includes("--hard") || rest.includes("--"))
    return cli({ ...input, argv: ["reset", ...rest] });

  const [target, ...others] = rest;

  const oid =
    target === undefined || others.length > 0 ? undefined : await resolves(client, dir, target);

  if (
    oid === undefined &&
    target !== undefined &&
    others.length === 0 &&
    (soft || mixed || REVISION_SYNTAX.test(target))
  )
    return failure(AMBIGUOUS(target));

  if (oid === undefined || (!soft && !mixed && target === "HEAD"))
    return soft ? OK : cli({ ...input, argv: ["reset", ...rest] });

  await moveHead(client, dir, oid);

  if (!soft) await client.reset({ dir, ref: oid });

  return OK;
}

export async function resetCommand(
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
  scope: GitScope,
): Promise<GitCliResult> {
  const args = input.argv.slice(1);
  const result = await resetWithoutReport(client, cli, input, scope, args);
  const quiet = args.includes("-q") || args.includes("--quiet") || args.includes("--soft");

  if (result.exitCode !== 0 || quiet) return result;

  return { ...result, stdout: await resetReport(client, scope.dir, args.includes("--hard")) };
}

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

function pathspecError(missed: readonly string[]): GitCliResult {
  return {
    stdout: "",
    stderr: missed
      .map((spec) => `error: pathspec '${spec}' did not match any file(s) known to git\n`)
      .join(""),
    exitCode: 1,
  };
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

  const changed = (await statusLines(client, dir)).filter(
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

export function pushDelete(input: GitCliInput): GitCliInput {
  const colon = input.argv.findIndex((arg, index) => index > 0 && /^:[^:]+$/u.test(arg));

  if (colon === -1) return input;

  return {
    ...input,
    argv: input.argv.flatMap((arg, index) =>
      index === colon ? ["--delete", arg.slice(1)] : [arg],
    ),
  };
}

export async function reportingFailure(run: () => Promise<GitCliResult>): Promise<GitCliResult> {
  try {
    return await run();
  } catch (cause) {
    return failure(`fatal: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  }
}
