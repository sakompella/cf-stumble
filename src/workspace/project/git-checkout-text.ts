import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import type { RunCli } from "./git-cli.js";
import { statusLines } from "./git-status.js";
import { branchTracking, trackingLines } from "./git-tracking.js";

const CREATE = new Set(["-b", "-c"]);

function underPaths(path: string, paths: readonly string[]): boolean {
  return paths.some(
    (spec) => spec === "." || path === spec || path.startsWith(`${spec.replace(/\/$/u, "")}/`),
  );
}

async function restorePaths(
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
  paths: readonly string[],
): Promise<GitCliResult> {
  const dir = input.cwd ?? "/";

  const touched = (await statusLines(client, dir)).filter(
    (line) => line.x !== "?" && underPaths(line.path, paths),
  );

  if (touched.some((line) => line.x !== " ")) return cli(input);

  const result = await cli({ ...input, argv: ["checkout", "HEAD", "--", ...paths] });
  const count = touched.length;

  return result.exitCode === 0
    ? {
        ...result,
        stderr: `Updated ${String(count)} path${count === 1 ? "" : "s"} from the index\n`,
      }
    : result;
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

export async function checkoutWithMessages(
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
): Promise<GitCliResult> {
  const args = input.argv.slice(1);
  const separator = args.indexOf("--");

  if (input.argv[0] === "checkout" && separator === 0)
    return restorePaths(client, cli, input, args.slice(1));

  if (separator !== -1) return cli(input);

  const dir = input.cwd ?? "/";
  const created = args.some((arg) => CREATE.has(arg));
  const target = args.find((arg) => !arg.startsWith("-"));
  const before = await client.currentBranch({ dir }).catch((): undefined => {});
  const result = await cli(input);

  if (result.exitCode !== 0 || target === undefined) return result;

  return switchMessages(client, dir, target, created, before).catch(() => result);
}
