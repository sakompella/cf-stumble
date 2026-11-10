import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import { branchSwitch } from "./git-checkout-branch.js";
import { restoreCommand } from "./git-restore-command.js";
import { reportingFailure } from "./git-result.js";
import type { GitScope, RunCli } from "./git-cli.js";
import type { ReadFile } from "./git-index-file.js";
import { branchTracking, trackingLines } from "./git-tracking.js";

const CREATE = new Set(["-b", "-c"]);

function createBranch(client: GitClient, dir: string, name: string): Promise<GitCliResult> {
  return client.branch({ dir, name, checkout: true }).then(
    () => ({ stdout: "", stderr: "", exitCode: 0 }),
    () => ({
      stdout: "",
      stderr: `fatal: a branch named '${name}' already exists\n`,
      exitCode: 128,
    }),
  );
}

async function switchMessages(
  client: GitClient,
  dir: string,
  target: string,
  created: boolean,
  before: string | undefined,
): Promise<GitCliResult> {
  const branch = await client.currentBranch({ dir });

  if (branch === undefined) {
    const commit = await client.show({ dir, ref: "HEAD" });
    const subject = commit.message.split("\n")[0] ?? "";

    return {
      stdout: "",
      stderr: `HEAD is now at ${commit.oid.slice(0, 7)} ${subject}\n`,
      exitCode: 0,
    };
  }

  const tracking = await branchTracking(client, dir, branch);

  const stderr =
    before === target && !created
      ? `Already on '${target}'\n`
      : `Switched to ${created ? "a new branch" : "branch"} '${branch}'\n`;

  return {
    stdout: tracking === undefined ? "" : `${trackingLines(tracking).join("\n")}\n`,
    stderr,
    exitCode: 0,
  };
}

const NO_SUCH_TARGET = /Could not find origin\/(.+)\.\n?$/u;

const PREVIOUS_BRANCH: GitCliResult = {
  stdout: "",
  stderr: "git checkout: '-' is not supported\n",
  exitCode: 129,
};

function unknownTarget(result: GitCliResult): GitCliResult {
  const named = NO_SUCH_TARGET.exec(result.stderr)?.[1];

  return named === undefined
    ? result
    : {
        stdout: "",
        stderr: `error: pathspec '${named}' did not match any file(s) known to git\n`,
        exitCode: 1,
      };
}

export async function checkoutWithMessages(
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
  scope: GitScope,
  readFile: ReadFile,
): Promise<GitCliResult> {
  const switching = branchSwitch(client, input, scope);
  const switched = switching === undefined ? undefined : await reportingFailure(() => switching);

  if (switched !== undefined) return switched;

  const args = input.argv.slice(1);
  const separator = args.indexOf("--");

  if (args.length === 1 && args[0] === "-") return PREVIOUS_BRANCH;

  if (input.argv[0] === "checkout" && separator === 0)
    return reportingFailure(() =>
      restoreCommand(client, { ...input, argv: ["restore", ...args] }, scope, readFile),
    );

  if (separator !== -1) return cli(input);

  const dir = scope.dir;
  const created = args.some((arg) => CREATE.has(arg));
  const target = args.find((arg) => !arg.startsWith("-"));
  const before = await client.currentBranch({ dir }).catch((): undefined => {});

  const result =
    created && args.length === 2 && target !== undefined
      ? await createBranch(client, dir, target)
      : await cli({ ...input, cwd: dir });

  if (result.exitCode !== 0) return unknownTarget(result);

  if (target === undefined) return result;

  return switchMessages(client, dir, target, created, before).catch(() => result);
}
