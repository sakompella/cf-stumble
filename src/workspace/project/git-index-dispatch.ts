import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import { addCommand } from "./git-add-command.js";
import type { GitScope, RunCli } from "./git-cli.js";
import type { ReadFile } from "./git-index-file.js";
import { resetCommand } from "./git-reset-command.js";
import { restoreCommand } from "./git-restore-command.js";
import { reportingFailure } from "./git-result.js";
import { rmCommand, type RemoveFile } from "./git-rm-command.js";

export function indexCommand(
  command: string,
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
  scope: GitScope,
  readFile: ReadFile,
  removeFile: RemoveFile,
): Promise<GitCliResult> | undefined {
  switch (command) {
    case "add":
      return reportingFailure(() => addCommand(client, cli, input, scope, readFile));
    case "rm":
      return reportingFailure(() => rmCommand(client, input, scope, removeFile, readFile));
    case "reset":
      return reportingFailure(() => resetCommand(client, cli, input, scope, readFile));
    case "restore":
      return reportingFailure(() => restoreCommand(client, input, scope, readFile));
    default:
      return undefined;
  }
}
