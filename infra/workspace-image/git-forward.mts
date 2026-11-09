import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";

type Forwarded = {
  stdout: string;
  stderr: string;
  exitCode: number;
  gitDir: string | null;
  state: Record<string, string>;
};

function isForwarded(value: unknown): value is Forwarded {
  return (
    typeof value === "object" &&
    value !== null &&
    "stdout" in value &&
    typeof value.stdout === "string" &&
    "stderr" in value &&
    typeof value.stderr === "string" &&
    "exitCode" in value &&
    typeof value.exitCode === "number" &&
    "gitDir" in value &&
    (value.gitDir === null || typeof value.gitDir === "string") &&
    "state" in value &&
    typeof value.state === "object" &&
    value.state !== null
  );
}

const argv = process.argv.slice(2);

const subcommand = process.env["CF_STUMBLE_GIT_SUB"] ?? "";

const realGit = process.env["CF_STUMBLE_REAL_GIT"] ?? "/usr/bin/git";

const endpoint = process.env["CF_STUMBLE_GIT_FORWARD_URL"] ?? "http://computer.internal/api";

const waitMs = Number(process.env["CF_STUMBLE_GIT_WAIT_MS"] ?? "20000");

function fail(message: string): never {
  process.stderr.write(`git ${subcommand}: ${message}\n`);

  return process.exit(1);
}

function query(...args: string[]): string {
  const ran = spawnSync(realGit, args, {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });

  return ran.status === 0 ? ran.stdout.trim() : "";
}

function commitOptions(args: string[]) {
  const { tokens } = parseArgs({
    args,
    options: { message: { type: "string", short: "m", multiple: true } },
    strict: false,
    allowPositionals: true,
    tokens: true,
  });

  return tokens.flatMap((token) => (token.kind === "option" ? [token] : []));
}

function skipsHooks(args: string[]): boolean {
  return commitOptions(args).some((option) => option.name === "no-verify" || option.name === "n");
}

function messageOf(args: string[]): string | undefined {
  const parts = commitOptions(args)
    .filter((option) => option.name === "message")
    .map((option) => option.value ?? "");

  return parts.length === 0 ? undefined : parts.join("\n\n");
}

function withMessage(args: string[], message: string): string[] {
  const options = commitOptions(args).filter((option) => option.name === "message");

  const values = new Set(
    options.filter((option) => option.inlineValue === false).map((option) => option.index + 1),
  );

  const flags = new Map(
    options.map((option) => {
      const arg = args[option.index] ?? "";

      return [option.index, option.rawName.startsWith("--") ? "" : arg.slice(1, arg.indexOf("m"))];
    }),
  );

  const kept = args.flatMap((arg, index) => {
    const remaining = flags.get(index);

    if (values.has(index)) return [];

    if (remaining === undefined) return [arg];

    return remaining === "" ? [] : [`-${remaining}`];
  });

  return [...kept, "-m", message];
}

function runHook(directory: string, name: string, cwd: string, hookArgs: string[]): number {
  const hook = join(directory, name);

  try {
    accessSync(hook, constants.X_OK);
  } catch {
    return 0;
  }

  return spawnSync(hook, hookArgs, { cwd, stdio: "inherit" }).status ?? 1;
}

function editedMessage(directory: string, cwd: string, message: string): string | null {
  const scratch = mkdtempSync(join(tmpdir(), "git-forward-"));

  try {
    const file = join(scratch, "COMMIT_EDITMSG");

    writeFileSync(file, `${message}\n`);

    return runHook(directory, "commit-msg", cwd, [file]) === 0
      ? readFileSync(file, "utf8").replace(/\n$/u, "")
      : null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function commitArguments(): string[] {
  const at = argv.indexOf(subcommand);
  const options = argv.slice(at + 1);

  if (subcommand !== "commit" || skipsHooks(options)) return argv;

  const leading = argv.slice(0, at);
  const top = query(...leading, "rev-parse", "--show-toplevel");
  const hooks = query(...leading, "-C", top, "rev-parse", "--git-path", "hooks");

  if (top === "" || hooks === "") return argv;

  const directory = resolvePath(top, hooks);

  if (runHook(directory, "pre-commit", top, []) !== 0) return fail("pre-commit hook failed");

  const message = messageOf(options);

  if (message === undefined) return argv;

  const edited = editedMessage(directory, top, message);

  if (edited === null) return fail("commit-msg hook failed");

  return edited === message ? argv : [...leading, subcommand, ...withMessage(options, edited)];
}

function digest(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "";
  }
}

function stale(result: Forwarded): string[] {
  if (result.gitDir === null) return [];

  const gitDir = result.gitDir;

  return Object.entries(result.state).flatMap(([name, expected]) =>
    digest(join(gitDir, name)) === expected ? [] : [name],
  );
}

async function settled(result: Forwarded): Promise<void> {
  const deadline = Date.now() + waitMs;

  while (stale(result).length > 0) {
    if (Date.now() > deadline)
      fail(
        `the workspace host ran it, but this container's .git still lacks the change (${stale(result).join(", ")}) after ${String(waitMs)} ms; run it again or check git status`,
      );

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
}

async function forward(args: string[]): Promise<Forwarded> {
  let response: Response;

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env["CF_STUMBLE_GIT_TOKEN"] ?? ""}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ argv: args, cwd: process.cwd() }),
    });
  } catch (cause) {
    return fail(
      `cannot reach the workspace host: ${cause instanceof Error ? cause.message : "unknown error"}`,
    );
  }

  if (!response.ok)
    return fail(`the workspace host answered ${String(response.status)}: ${await response.text()}`);

  const body: unknown = await response.json();

  return isForwarded(body) ? body : fail("the workspace host sent an unreadable answer");
}

const result = await forward(commitArguments());

await settled(result);

process.stdout.write(result.stdout);

process.stderr.write(result.stderr);

process.exitCode = result.exitCode;
