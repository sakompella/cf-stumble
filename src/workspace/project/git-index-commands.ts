import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import type { GitScope, RunCli } from "./git-cli.js";
import { statusLines } from "./git-status.js";

const OK: GitCliResult = { stdout: "", stderr: "", exitCode: 0 };

function failure(stderr: string): GitCliResult {
  return { stdout: "", stderr, exitCode: 128 };
}

function without(argv: readonly string[], flags: readonly string[]): string[] {
  return argv.filter((arg) => !flags.includes(arg));
}

export function rooted(path: string, prefix: string): string | undefined {
  if (prefix === "") return path;

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

function under(path: string, spec: string): boolean {
  const bare = spec.replace(/\/$/u, "");

  return path === bare || path.startsWith(`${bare}/`) || path === `${bare}/`;
}

async function stage(
  client: GitClient,
  dir: string,
  lines: readonly { readonly path: string; readonly y: string }[],
): Promise<void> {
  const changed = lines.flatMap((line) => (line.y === "D" ? [] : [line.path.replace(/\/$/u, "")]));
  const deleted = lines.flatMap((line) => (line.y === "D" ? [line.path] : []));

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
    if (scope.prefix === "" || args.some((arg) => arg.startsWith("-"))) return cli(input);

    const specs: string[] = [];

    for (const path of rest) {
      const at = rooted(path, scope.prefix);

      if (at === undefined) return failure(`fatal: '${path}' is outside repository\n`);

      specs.push(at);
    }

    const lines = await statusLines(client, scope.dir);
    const matched = lines.filter((line) => specs.some((spec) => under(line.path, spec)));

    if (matched.length < specs.length) {
      const missed = specs.filter((spec) => !matched.some((line) => under(line.path, spec)));

      return failure(`fatal: pathspec '${missed[0]}' did not match any files\n`);
    }

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

export async function resetCommand(
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
  scope: GitScope,
): Promise<GitCliResult> {
  const args = input.argv.slice(1);
  const soft = args.includes("--soft");
  const mixed = args.includes("--mixed");
  const rest = without(args, ["--soft", "--mixed"]);
  const dir = scope.dir;

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

export async function restoreCommand(
  client: GitClient,
  input: GitCliInput,
  scope: GitScope,
): Promise<GitCliResult> {
  const request = restoreRequest(input.argv.slice(1));
  const dir = scope.dir;

  if (!request.supported || !request.staged || request.paths.length === 0)
    return { stdout: "", stderr: RESTORE_UNSUPPORTED, exitCode: 129 };

  const oid =
    request.source === undefined ? undefined : await resolves(client, dir, request.source);

  if (request.source !== undefined && oid === undefined)
    return failure(`fatal: ambiguous argument '${request.source}': unknown revision or path\n`);

  const target = oid === undefined ? {} : { ref: oid };

  if (scope.prefix === "") {
    await client.reset(
      request.paths.includes(".")
        ? { dir, ...target }
        : { dir, paths: [...request.paths], ...target },
    );

    return OK;
  }

  const specs: string[] = [];

  for (const path of request.paths) {
    const at = rooted(path, scope.prefix);

    if (at === undefined) return failure(`fatal: '${path}' is outside repository\n`);

    specs.push(at);
  }

  const staged = (await statusLines(client, dir)).filter(
    (line) => line.x !== " " && line.x !== "?",
  );

  const paths = staged
    .filter((line) => specs.some((spec) => under(line.path, spec)))
    .map((line) => line.path);

  if (paths.length === 0) return OK;

  await client.reset({ dir, paths, ...target });

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
