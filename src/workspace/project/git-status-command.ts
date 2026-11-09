import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import type { RunCli } from "./git-cli.js";
import { shortStatus, statusLines } from "./git-status.js";
import { branchHeader, headState, longStatus } from "./git-status-text.js";

type Format = "long" | "short" | "v2";

const PORCELAIN_V2_UNSUPPORTED =
  "error: --porcelain=v2 is not implemented by the workspace git\n";

interface StatusOptions {
  readonly format: Format;
  readonly branch: boolean;
}

const FORMATS = new Map<string, Format>([
  ["--long", "long"],
  ["-s", "short"],
  ["--short", "short"],
  ["--porcelain", "short"],
  ["--porcelain=1", "short"],
  ["--porcelain=v1", "short"],
  ["--porcelain=2", "v2"],
  ["--porcelain=v2", "v2"],
]);

function parseOptions(args: readonly string[]): StatusOptions | undefined {
  let format: Format = "long";
  let branch = false;

  for (const arg of args) {
    const known = FORMATS.get(arg);

    if (known !== undefined) format = known;
    else if (arg === "-b" || arg === "--branch") branch = true;
    else if (arg === "-sb" || arg === "-bs") {
      format = "short";
      branch = true;
    } else return undefined;
  }

  return { format, branch };
}

async function render(client: GitClient, dir: string, options: StatusOptions): Promise<string> {
  const needsHead = options.format === "long" || options.branch;

  const [head, lines] = await Promise.all([
    needsHead ? headState(client, dir) : undefined,
    statusLines(client, dir),
  ]);

  if (options.format === "long" && head !== undefined) return longStatus(head, lines);

  return `${head === undefined ? "" : branchHeader(head)}${shortStatus(lines)}`;
}

export async function statusCommand(
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
): Promise<GitCliResult> {
  const options = parseOptions(input.argv.slice(1));

  if (options === undefined) return cli(input);

  if (options.format === "v2")
    return { stdout: "", stderr: PORCELAIN_V2_UNSUPPORTED, exitCode: 129 };

  return render(client, input.cwd ?? "/", options).then(
    (stdout) => ({ stdout, stderr: "", exitCode: 0 }),
    () => cli(input),
  );
}
