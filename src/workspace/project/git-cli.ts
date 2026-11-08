import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import { verboseBranches } from "./git-branch-text.js";
import { checkoutWithMessages } from "./git-checkout-text.js";
import { commitWithSummary } from "./git-commit-text.js";
import { statusCommand } from "./git-status-command.js";

export type RunCli = (input: GitCliInput) => Promise<GitCliResult>;

const IDENTITY_ENV = new Map([
  ["user.name", ["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"]],
  ["user.email", ["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"]],
]);

function withGlobalOptions(input: GitCliInput): GitCliInput {
  const env = { ...input.env };
  let cwd = input.cwd ?? "/";
  let index = 0;

  for (;;) {
    const option = input.argv[index];
    const value = input.argv[index + 1];

    if (option === "--no-pager") index += 1;
    else if (option === "-c" && value !== undefined) {
      const [key = "", ...rest] = value.split("=");

      for (const name of IDENTITY_ENV.get(key.toLowerCase()) ?? []) env[name] = rest.join("=");
      index += 2;
    } else if (option === "-C" && value !== undefined) {
      cwd = value.startsWith("/") ? value : `${cwd.replace(/\/$/u, "")}/${value}`;
      index += 2;
    } else break;
  }

  return { ...input, argv: input.argv.slice(index), cwd, env };
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
  const input = withGlobalOptions(original);
  const [command] = input.argv;
  const dir = input.cwd ?? "/";

  switch (command ?? "") {
    case "status":
      return statusCommand(client, cli, input);
    case "commit":
      return commitWithSummary(client, cli, await withConfiguredIdentity(client, input, dir));
    case "checkout":
    case "switch":
      return checkoutWithMessages(client, cli, input);
    case "branch":
      return verboseBranches(client, cli, input);
    default:
      return cli(input);
  }
}
