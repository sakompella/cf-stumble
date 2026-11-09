import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import type { RunCli } from "./git-cli.js";

const OK: GitCliResult = { stdout: "", stderr: "", exitCode: 0 };

function failure(stderr: string): GitCliResult {
  return { stdout: "", stderr, exitCode: 128 };
}

function without(argv: readonly string[], flags: readonly string[]): string[] {
  return argv.filter((arg) => !flags.includes(arg));
}

function root(input: GitCliInput): string {
  return input.cwd ?? "/";
}

export async function addCommand(
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
): Promise<GitCliResult> {
  const rest = without(input.argv.slice(1), ["-u", "--update"]);

  if (rest.length === input.argv.length - 1 || rest.some((arg) => arg !== ".")) return cli(input);

  const dir = root(input);
  const entries = await client.status({ dir });
  const changed = entries.filter((entry) => entry.worktree === "M").map((entry) => entry.path);
  const deleted = entries.filter((entry) => entry.worktree === "D").map((entry) => entry.path);

  if (changed.length > 0) await client.add({ dir, paths: changed });

  if (deleted.length > 0) await client.rm({ dir, paths: deleted });

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

export async function resetCommand(
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
): Promise<GitCliResult> {
  const args = input.argv.slice(1);
  const soft = args.includes("--soft");
  const mixed = args.includes("--mixed");
  const rest = without(args, ["--soft", "--mixed"]);
  const dir = root(input);

  if (args.includes("--hard") || rest.includes("--"))
    return cli({ ...input, argv: ["reset", ...rest] });

  const [target, ...others] = rest;

  const oid =
    target === undefined || others.length > 0 ? undefined : await resolves(client, dir, target);

  if (oid === undefined && target !== undefined && (soft || mixed) && others.length === 0)
    return failure(`fatal: ambiguous argument '${target}': unknown revision or path\n`);

  if (oid === undefined || (!soft && !mixed && target === "HEAD"))
    return soft ? OK : cli({ ...input, argv: ["reset", ...rest] });

  await moveHead(client, dir, oid);

  if (!soft) await client.reset({ dir, ref: oid });

  return OK;
}

const RESTORE_UNSUPPORTED =
  "error: restoring the working tree is not supported by this git; only --staged is\nusage: git restore --staged [--source <tree-ish>] [--] <pathspec>...\n";

interface RestoreRequest {
  readonly staged: boolean;
  readonly source: string | undefined;
  readonly paths: readonly string[];
  readonly supported: boolean;
}

function restoreRequest(args: readonly string[]): RestoreRequest {
  let staged = false;
  let source: string | undefined;
  let supported = true;
  const paths: string[] = [];
  let index = 0;

  while (index < args.length) {
    const arg = args[index++] ?? "";

    if (arg === "--") {
      paths.push(...args.slice(index));
      return { staged, source, paths, supported };
    }

    if (arg === "--staged" || arg === "-S") staged = true;
    else if (arg === "--source" || arg === "-s") source = args[index++];
    else if (arg.startsWith("--source=")) source = arg.slice("--source=".length);
    else if (arg.startsWith("-")) supported = false;
    else paths.push(arg);
  }

  return { staged, source, paths, supported };
}

export async function restoreCommand(client: GitClient, input: GitCliInput): Promise<GitCliResult> {
  const request = restoreRequest(input.argv.slice(1));
  const dir = root(input);

  if (!request.supported || !request.staged || request.paths.length === 0)
    return { stdout: "", stderr: RESTORE_UNSUPPORTED, exitCode: 129 };

  const oid =
    request.source === undefined ? undefined : await resolves(client, dir, request.source);

  if (request.source !== undefined && oid === undefined)
    return failure(`fatal: ambiguous argument '${request.source}': unknown revision or path\n`);

  const target = oid === undefined ? {} : { ref: oid };

  await client.reset(
    request.paths.includes(".")
      ? { dir, ...target }
      : { dir, paths: [...request.paths], ...target },
  );

  return OK;
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
