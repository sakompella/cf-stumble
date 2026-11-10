import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import type { GitScope, RunCli } from "./git-cli.js";
import { type ReadFile, withRenames } from "./git-rename.js";
import { shortStatus, statusLines, type StatusLine } from "./git-status.js";
import { branchHeader, headState, longStatus } from "./git-status-text.js";

type Format = "long" | "short" | "porcelain" | "v2";

const PORCELAIN_V2_UNSUPPORTED = "error: --porcelain=v2 is not implemented by the workspace git\n";

interface StatusOptions {
  readonly format: Format;
  readonly branch: boolean;
}

const FORMATS = new Map<string, Format>([
  ["--long", "long"],
  ["-s", "short"],
  ["--short", "short"],
  ["--porcelain", "porcelain"],
  ["--porcelain=1", "porcelain"],
  ["--porcelain=v1", "porcelain"],
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

  const directories = prefix.split("/");
  const parts = path.split("/");
  let shared = 0;

  while (
    shared < directories.length &&
    shared < parts.length - 1 &&
    parts[shared] === directories[shared]
  )
    shared += 1;

  const shown = `${"../".repeat(directories.length - shared)}${parts.slice(shared).join("/")}`;

  return shown === "" ? "./" : shown;
}

async function render(
  client: GitClient,
  scope: GitScope,
  readFile: ReadFile,
  options: StatusOptions,
): Promise<string> {
  const needsHead = options.format === "long" || options.branch;

  const [head, lines] = await Promise.all([
    needsHead ? headState(client, scope.dir) : undefined,
    statusLines(client, scope.dir).then((found) => withRenames(client, scope.dir, readFile, found)),
  ]);

  const prefix = options.format === "porcelain" ? "" : scope.prefix;

  const shown = lines.map((line): StatusLine => {
    const path = displayPath(line.path, prefix);

    if (line.from === undefined) return { ...line, path };

    return { ...line, path, from: displayPath(line.from, prefix) };
  });

  if (options.format === "long" && head !== undefined) return longStatus(head, shown);

  return `${head === undefined ? "" : branchHeader(head)}${shortStatus(shown)}`;
}

export function statusCommand(
  client: GitClient,
  cli: RunCli,
  input: GitCliInput,
  scope: GitScope,
  readFile: ReadFile,
): Promise<GitCliResult> {
  const options = parseOptions(input.argv.slice(1));

  if (options === undefined) return cli(input);

  if (options.format === "v2")
    return Promise.resolve({ stdout: "", stderr: PORCELAIN_V2_UNSUPPORTED, exitCode: 129 });

  return render(client, scope, readFile, options).then(
    (stdout) => ({ stdout, stderr: "", exitCode: 0 }),
    () => cli(input),
  );
}
