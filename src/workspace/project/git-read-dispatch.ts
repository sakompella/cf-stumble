import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import type { GitScope, RunCli } from "./git-cli.js";
import type { WorkFiles } from "./git-index-file.js";
import { logCommand } from "./git-log-command.js";
import { reportingFailure } from "./git-result.js";
import { statusCommand } from "./git-status-command.js";

export function readCommand(
  command: string,
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
  scope: GitScope,
  files: WorkFiles,
): Promise<GitCliResult> | undefined {
  switch (command) {
    case "status":
      return statusCommand(client, cli, input, scope, files.read);
    case "log":
      return reportingFailure(() => logCommand(client, input, scope, files));
    default:
      return undefined;
  }
}
