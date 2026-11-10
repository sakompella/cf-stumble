import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import { verboseBranches } from "./git-branch-text.js";
import { checkoutWithMessages } from "./git-checkout-text.js";
import type { GitScope, RunCli } from "./git-cli.js";
import { commitWithSummary } from "./git-commit-text.js";
import { indexCommand } from "./git-index-dispatch.js";
import type { WorkFiles } from "./git-index-file.js";
import { pushDelete } from "./git-push-delete.js";
import { statusCommand } from "./git-status-command.js";

export function dispatchGit(
  command: string,
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
  scope: GitScope,
  files: WorkFiles,
): Promise<GitCliResult> {
  switch (command) {
    case "status":
      return statusCommand(client, cli, input, scope, files.read);
    case "commit":
      return commitWithSummary(client, cli, input, scope, files.read);
    case "checkout":
    case "switch":
      return checkoutWithMessages(client, cli, input, scope, files.read);
    case "branch":
      return verboseBranches(client, cli, input, scope);
    case "push":
      return cli(pushDelete(input));
    default:
      return indexCommand(command, client, cli, input, scope, files) ?? cli(input);
  }
}
