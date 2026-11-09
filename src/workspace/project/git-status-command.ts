import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import type { GitScope, RunCli } from "./git-cli.js";
import { shortStatus, statusLines } from "./git-status.js";
import { branchHeader, headState, longStatus } from "./git-status-text.js";

type Format = "long" | "short" | "v2";

const PORCELAIN_V2_UNSUPPORTED = "error: --porcelain=v2 is not implemented by the workspace git\n";

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

function displayPath(path: string, prefix: string): string {
  if (prefix === "") return path;

  if (path === prefix || path.startsWith(`${prefix}/`)) {
    const suffix = path.slice(prefix.length).replace(/^\//u, "");

    return suffix === "" ? "./" : suffix;
  }

  return `${"../".repeat(prefix.split("/").length)}${path}`;
}

async function render(client: GitClient, scope: GitScope, options: StatusOptions): Promise<string> {
  const needsHead = options.format === "long" || options.branch;

  const [head, lines] = await Promise.all([
    needsHead ? headState(client, scope.dir) : undefined,
    statusLines(client, scope.dir),
  ]);

  const shown = lines.map((line) => ({ ...line, path: displayPath(line.path, scope.prefix) }));

  if (options.format === "long" && head !== undefined) return longStatus(head, shown);

  return `${head === undefined ? "" : branchHeader(head)}${shortStatus(shown)}`;
}

export function statusCommand(
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
  scope: GitScope,
): Promise<GitCliResult> {
  const options = parseOptions(input.argv.slice(1));

  if (options === undefined) return cli(input);

  if (options.format === "v2")
    return Promise.resolve({ stdout: "", stderr: PORCELAIN_V2_UNSUPPORTED, exitCode: 129 });

  return render(client, scope, options).then(
    (stdout) => ({ stdout, stderr: "", exitCode: 0 }),
    () => cli(input),
  );
}
