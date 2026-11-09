import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import { verboseBranches } from "./git-branch-text.js";
import { checkoutWithMessages } from "./git-checkout-text.js";
import { commitWithSummary } from "./git-commit-text.js";
import {
  addCommand,
  pushDelete,
  reportingFailure,
  resetCommand,
  restoreCommand,
} from "./git-index-commands.js";
import { statusCommand } from "./git-status-command.js";

export type RunCli = (input: GitCliInput) => Promise<GitCliResult>;

const IDENTITY_ENV = new Map([
  ["user.name", ["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"]],
  ["user.email", ["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"]],
]);

export interface GitScope {
  readonly dir: string;
  readonly prefix: string;
}

export async function gitScope(client: GitClient, cwd: string): Promise<GitScope> {
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
): Promise<GitCliResult> {
  const resolved = resolveGlobalOptions(original);

  if ("failure" in resolved) return resolved.failure;

  const input = resolved.input;
  const [command] = input.argv;
  const scope = await gitScope(client, input.cwd ?? "/");

  switch (command ?? "") {
    case "status":
      return statusCommand(client, cli, input, scope);
    case "commit":
      return commitWithSummary(
        client,
        cli,
        await withConfiguredIdentity(client, input, scope.dir),
        scope,
      );
    case "checkout":
    case "switch":
      return checkoutWithMessages(client, cli, input, scope);
    case "branch":
      return verboseBranches(client, cli, input, scope);
    case "add":
      return reportingFailure(() => addCommand(client, cli, input, scope));
    case "reset":
      return reportingFailure(() => resetCommand(client, cli, input, scope));
    case "restore":
      return reportingFailure(() => restoreCommand(client, input, scope));
    case "push":
      return cli(pushDelete(input));
    default:
      return cli(input);
  }
}
