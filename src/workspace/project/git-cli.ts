import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import { dispatchGit } from "./git-dispatch.js";
import type { ReadFile } from "./git-index-file.js";
import type { RemoveFile } from "./git-rm-command.js";

export type RunCli = (input: GitCliInput) => Promise<GitCliResult>;

const IDENTITY_ENV = new Map([
  ["user.name", ["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"]],
  ["user.email", ["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"]],
]);

export interface GitScope {
  readonly dir: string;
  readonly prefix: string;
}

async function gitScope(client: GitClient, cwd: string): Promise<GitScope> {
  const dir = await client.repoRoot({ dir: cwd }).catch((): string => cwd);

  return {
    dir,
    prefix: dir === cwd || !cwd.startsWith(`${dir}/`) ? "" : cwd.slice(dir.length + 1),
  };
}

export type GlobalOptions = Readonly<{ input: GitCliInput }> | Readonly<{ failure: GitCliResult }>;

export function resolveGlobalOptions(input: GitCliInput): GlobalOptions {
  const env = { ...input.env };
  let cwd = input.cwd ?? "/";
  let index = 0;

  for (;;) {
    const option = input.argv[index];
    const value = input.argv[index + 1];

    if (option === "--no-pager") index += 1;
    else if (option === "-c" && value !== undefined) {
      const [key = "", ...rest] = value.split("=");
      const names = IDENTITY_ENV.get(key.toLowerCase());

      if (names === undefined)
        return {
          failure: {
            stdout: "",
            stderr: `error: unsupported -c setting '${key}'\n`,
            exitCode: 129,
          },
        };

      for (const name of names) env[name] = rest.join("=");
      index += 2;
    } else if (option === "-C" && value !== undefined) {
      cwd = value.startsWith("/") ? value : `${cwd.replace(/\/$/u, "")}/${value}`;
      index += 2;
    } else break;
  }

  return { input: { ...input, argv: input.argv.slice(index), cwd, env } };
}

async function withConfiguredIdentity(
  client: GitClient,
  input: GitCliInput,
  dir: string,
): Promise<GitCliInput> {
  const env = { ...input.env };

  if ([...IDENTITY_ENV.values()].every((names) => names.every((name) => env[name] === undefined)))
    return input;

  for (const [key, names] of IDENTITY_ENV) {
    if (names.every((name) => env[name] === undefined)) {
      const value = await client.configGet({ dir, path: key });

      const first = Array.isArray(value) ? value[0] : value;

      if (first !== undefined) for (const name of names) env[name] = first;
    }
  }

  return { ...input, env };
}

export async function gitCli(
  client: GitClient,
  cli: RunCli,
  original: GitCliInput,
  readFile: ReadFile,
  removeFile: RemoveFile,
): Promise<GitCliResult> {
  const resolved = resolveGlobalOptions(original);

  if ("failure" in resolved) return resolved.failure;

  const input = resolved.input;
  const [command] = input.argv;
  const scope = await gitScope(client, input.cwd ?? "/");

  const prepared =
    command === "commit" ? await withConfiguredIdentity(client, input, scope.dir) : input;

  return dispatchGit(command ?? "", client, cli, prepared, scope, readFile, removeFile);
}
