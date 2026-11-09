import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

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

function messageOf(args: string[]): string | undefined {
  const parts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";

    if (arg === "-m" || arg === "--message") parts.push(args[(index += 1)] ?? "");
    else if (arg.startsWith("--message=")) parts.push(arg.slice("--message=".length));
    else if (arg === "-F" || arg === "--file") return readFileSync(args[index + 1] ?? "", "utf8");
  }

  return parts.length === 0 ? undefined : parts.join("\n\n");
}

function withMessage(args: string[], message: string): string[] {
  const kept: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";

    if (arg === "-m" || arg === "--message") index += 1;
    else if (!arg.startsWith("--message=")) kept.push(arg);
  }

  return [...kept, "-m", message];
}

function runHook(directory: string, name: string, cwd: string, hookArgs: string[]): void {
  const hook = join(directory, name);

  try {
    accessSync(hook, constants.X_OK);
  } catch {
    return;
  }

  const ran = spawnSync(hook, hookArgs, { cwd, stdio: "inherit" });

  if (ran.status !== 0) fail(`${name} hook failed`);
}

function commitArguments(): string[] {
  if (
    subcommand !== "commit" ||
    argv.some((arg) => arg === "--no-verify" || /^-[a-z]*n[a-z]*$/u.test(arg))
  )
    return argv;

  const leading = argv.slice(0, argv.indexOf(subcommand));
  const top = query(...leading, "rev-parse", "--show-toplevel");
  const hooks = query(...leading, "-C", top, "rev-parse", "--git-path", "hooks");

  if (top === "" || hooks === "") return argv;

  const directory = resolvePath(top, hooks);

  runHook(directory, "pre-commit", top, []);

  const message = messageOf(argv);

  if (message === undefined) return argv;

  const scratch = mkdtempSync(join(tmpdir(), "git-forward-"));
  const file = join(scratch, "COMMIT_EDITMSG");

  writeFileSync(file, `${message}\n`);
  runHook(directory, "commit-msg", top, [file]);

  const edited = readFileSync(file, "utf8").replace(/\n$/u, "");

  rmSync(scratch, { recursive: true, force: true });

  return edited === message ? argv : withMessage(argv, edited);
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
