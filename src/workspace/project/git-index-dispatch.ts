import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import { addCommand } from "./git-add-command.js";
import type { GitScope, RunCli } from "./git-cli.js";
import type { WorkFiles } from "./git-index-file.js";
import { resetCommand } from "./git-reset-command.js";
import { restoreCommand } from "./git-restore-command.js";
import { reportingFailure } from "./git-result.js";
import { rmCommand } from "./git-rm-command.js";

export function indexCommand(
  command: string,
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
  scope: GitScope,
  files: WorkFiles,
): Promise<GitCliResult> | undefined {
  switch (command) {
    case "add":
      return reportingFailure(() => addCommand(client, cli, input, scope, files));
    case "rm":
      return reportingFailure(() => rmCommand(client, input, scope, files.remove, files.read));
    case "reset":
      return reportingFailure(() => resetCommand(client, cli, input, scope, files.read));
    case "restore":
      return reportingFailure(() => restoreCommand(client, input, scope, files.read));
    default:
      return undefined;
  }
}
