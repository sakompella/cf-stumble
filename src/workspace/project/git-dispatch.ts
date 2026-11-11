import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import { verboseBranches } from "./git-branch-text.js";
import { checkoutWithMessages } from "./git-checkout-text.js";
import type { GitScope, RunCli } from "./git-cli.js";
import { commitWithSummary } from "./git-commit-text.js";
import { indexCommand } from "./git-index-dispatch.js";
import type { WorkFiles } from "./git-index-file.js";
import { remoteCommand } from "./git-remote-dispatch.js";
import { unbornCommand } from "./git-unborn.js";
import { readCommand } from "./git-read-dispatch.js";

export async function dispatchGit(
  command: string,
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
  scope: GitScope,
  files: WorkFiles,
): Promise<GitCliResult> {
  const unborn = await unbornCommand(command, client, input, scope, files);

  if (unborn !== undefined) return unborn;

  switch (command) {
    case "commit":
      return commitWithSummary(client, cli, input, scope, files.read);
    case "checkout":
    case "switch":
      return checkoutWithMessages(client, cli, input, scope, files.read);
    case "branch":
      return verboseBranches(client, cli, input, scope);
    default:
      return (
        indexCommand(command, client, cli, input, scope, files) ??
        readCommand(command, client, cli, input, scope, files) ??
        remoteCommand(command, client, cli, input, scope, files) ??
        cli(input)
      );
  }
}
