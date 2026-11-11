import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import type { GitScope, RunCli } from "./git-cli.js";
import { fetchCommand } from "./git-fetch-command.js";
import { pushCommand } from "./git-push-command.js";
import { reportingFailure } from "./git-result.js";

export function remoteCommand(
  command: string,
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
  scope: GitScope,
): Promise<GitCliResult> | undefined {
  switch (command) {
    case "push":
      return reportingFailure(() => pushCommand(client, cli, input, scope));
    case "fetch":
    case "pull":
      return reportingFailure(() => fetchCommand(client, cli, input, scope));
    default:
      return undefined;
  }
}
