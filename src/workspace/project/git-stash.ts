import type { GitCliInput, GitCliResult } from "@cloudflare/computer/git";
import type { GitScope, RunCli } from "./git-cli.js";
import type { WorkFiles } from "./git-index-file.js";

export async function stashCommand(
  cli: RunCli,
  input: GitCliInput,
  scope: GitScope,
  files: WorkFiles,
): Promise<GitCliResult> {
  await files.mkdir(`${scope.dir}/.git/refs`);
  await files.mkdir(`${scope.dir}/.git/logs/refs`);

  return cli(input);
}
