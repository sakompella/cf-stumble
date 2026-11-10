import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import { without } from "./git-args.js";
import type { GitScope, RunCli } from "./git-cli.js";
import type { ReadFile } from "./git-index-file.js";
import { failure, OK } from "./git-result.js";
import { AMBIGUOUS, resolves } from "./git-revision.js";
import { statusLines } from "./git-status.js";

async function moveHead(client: GitClient, dir: string, oid: string): Promise<void> {
  const branch = await client.currentBranch({ dir });

  await client.updateRef({
    dir,
    ref: branch === undefined ? "HEAD" : `refs/heads/${branch}`,
    value: oid,
    force: true,
  });
}

async function resetReport(
  client: GitClient,
  dir: string,
  hard: boolean,
  readFile: ReadFile,
): Promise<string> {
  if (hard) {
    const head = await client.show({ dir, ref: "HEAD" });

    return `HEAD is now at ${head.oid.slice(0, 7)} ${head.message.split("\n")[0] ?? ""}\n`;
  }

  const unstaged = (await statusLines(client, dir, readFile)).filter(
    (line) => line.x !== "?" && line.y !== " ",
  );

  return unstaged.length === 0
    ? ""
    : `Unstaged changes after reset:\n${unstaged.map((line) => `${line.y}\t${line.path}\n`).join("")}`;
}

const REVISION_SYNTAX = /[~^@]/u;

async function resetWithoutReport(
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
  scope: GitScope,
  args: readonly string[],
): Promise<GitCliResult> {
  const soft = args.includes("--soft");
  const mixed = args.includes("--mixed");
  const rest = without(args, ["--soft", "--mixed", "-q", "--quiet"]);
  const dir = scope.dir;

  if (args.includes("--hard") || rest.includes("--"))
    return cli({ ...input, argv: ["reset", ...rest] });

  const [target, ...others] = rest;

  const oid =
    target === undefined || others.length > 0 ? undefined : await resolves(client, dir, target);

  if (
    oid === undefined &&
    target !== undefined &&
    others.length === 0 &&
    (soft || mixed || REVISION_SYNTAX.test(target))
  )
    return failure(AMBIGUOUS(target));

  if (oid === undefined || (!soft && !mixed && target === "HEAD"))
    return soft ? OK : cli({ ...input, argv: ["reset", ...rest] });

  await moveHead(client, dir, oid);

  if (!soft) await client.reset({ dir, ref: oid });

  return OK;
}

export async function resetCommand(
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
  scope: GitScope,
  readFile: ReadFile,
): Promise<GitCliResult> {
  const args = input.argv.slice(1);
  const result = await resetWithoutReport(client, cli, input, scope, args);
  const quiet = args.includes("-q") || args.includes("--quiet") || args.includes("--soft");

  if (result.exitCode !== 0 || quiet) return result;

  return {
    ...result,
    stdout: await resetReport(client, scope.dir, args.includes("--hard"), readFile),
  };
}
