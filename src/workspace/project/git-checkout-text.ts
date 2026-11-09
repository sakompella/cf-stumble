import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import { rooted } from "./git-index-commands.js";
import type { GitScope, RunCli } from "./git-cli.js";
import { statusLines } from "./git-status.js";
import { branchTracking, trackingLines } from "./git-tracking.js";

const CREATE = new Set(["-b", "-c"]);

function underPaths(path: string, paths: readonly string[]): boolean {
  return paths.some(
    (spec) => spec === "." || path === spec || path.startsWith(`${spec.replace(/\/$/u, "")}/`),
  );
}

const OUTSIDE = "fatal: pathspec is outside repository\n";

async function restorePaths(
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
  scope: GitScope,
  paths: readonly string[],
): Promise<GitCliResult> {
  const specs: string[] = [];

  for (const path of paths) {
    const at = rooted(path, scope.prefix);

    if (at === undefined) return { stdout: "", stderr: OUTSIDE, exitCode: 128 };

    specs.push(at);
  }

  const touched = (await statusLines(client, scope.dir)).filter(
    (line) => line.x !== "?" && underPaths(line.path, specs),
  );

  if (touched.some((line) => line.x !== " ")) return cli(input);

  const result = await cli({
    ...input,
    cwd: scope.dir,
    argv: ["checkout", "HEAD", "--", ...specs],
  });

  const count = touched.length;

  return result.exitCode === 0
    ? {
        ...result,
        stderr: `Updated ${String(count)} path${count === 1 ? "" : "s"} from the index\n`,
      }
    : result;
}

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

export async function checkoutWithMessages(
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
  scope: GitScope,
): Promise<GitCliResult> {
  const args = input.argv.slice(1);
  const separator = args.indexOf("--");

  if (input.argv[0] === "checkout" && separator === 0)
    return restorePaths(client, cli, input, scope, args.slice(1));

  if (separator !== -1) return cli(input);

  const dir = scope.dir;
  const created = args.some((arg) => CREATE.has(arg));
  const target = args.find((arg) => !arg.startsWith("-"));
  const before = await client.currentBranch({ dir }).catch((): undefined => {});

  const result =
    created && args.length === 2 && target !== undefined
      ? await createBranch(client, dir, target)
      : await cli({ ...input, cwd: dir });

  if (result.exitCode !== 0 || target === undefined) return result;

  return switchMessages(client, dir, target, created, before).catch(() => result);
}
