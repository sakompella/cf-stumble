import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import type { GitScope } from "./git-cli.js";
import type { WorkFiles } from "./git-index-file.js";
import { matching, resolveSpecs } from "./git-pathspec.js";
import { failure, OK, pathspecError } from "./git-result.js";
import { AMBIGUOUS, resolves } from "./git-revision.js";

const UNBORN_COMMANDS = new Set([
  "reset",
  "checkout",
  "switch",
  "show",
  "merge",
  "stash",
  "tag",
  "diff",
  "rev-parse",
]);

const RESET_MODES = new Set(["--mixed", "-q", "--quiet"]);

async function worktreeHas(files: WorkFiles, dir: string, path: string): Promise<boolean> {
  try {
    await files.read(`${dir}/${path}`);

    return true;
  } catch {
    return false;
  }
}

async function resetUnborn(
  client: GitClient,
  scope: GitScope,
  files: WorkFiles,
  args: readonly string[],
): Promise<GitCliResult | undefined> {
  const hard = args.includes("--hard");
  const flagged = args.filter((arg) => arg.startsWith("-") && arg !== "--");
  const separator = args.indexOf("--");

  const words = args.filter(
    (arg, index) => !arg.startsWith("-") && (separator === -1 || index < separator),
  );

  if (flagged.some((arg) => arg !== "--hard" && !RESET_MODES.has(arg))) return undefined;

  const paths = separator === -1 ? words : args.slice(separator + 1);
  const known = await client.lsFiles({ dir: scope.dir });

  if (separator === -1)
    for (const word of words)
      if (matching(known, word).length === 0 && !(await worktreeHas(files, scope.dir, word)))
        return failure(AMBIGUOUS(word));

  const specs = resolveSpecs(paths, scope.prefix);

  if ("outside" in specs) return failure(`fatal: '${specs.outside}' is outside repository\n`);

  const targets =
    specs.length === 0 ? known : [...new Set(specs.flatMap((spec) => matching(known, spec)))];

  if (hard && paths.length > 0) return undefined;

  if (targets.length > 0) await client.rm({ dir: scope.dir, paths: [...targets] });

  if (hard) for (const path of targets) await files.remove(`${scope.dir}/${path}`, scope.dir);

  return OK;
}

async function checkoutUnborn(
  client: GitClient,
  scope: GitScope,
  command: string,
  args: readonly string[],
): Promise<GitCliResult | undefined> {
  if (args.some((arg) => arg.startsWith("-") && arg !== "--")) return undefined;

  const separator = args.indexOf("--");
  const [target] = args;

  if (target === undefined || target === "--") return undefined;

  if (command === "switch" || separator > 0)
    return failure(`fatal: invalid reference: ${target}\n`);

  if (args.length > 1) return undefined;

  const known = await client.lsFiles({ dir: scope.dir });

  return matching(known, target).length === 0 ? pathspecError([target]) : undefined;
}

function unbornResult(
  command: string,
  args: readonly string[],
  branch: string,
): GitCliResult | undefined {
  const [first] = args;

  switch (command) {
    case "show":
      return first === undefined
        ? failure(`fatal: your current branch '${branch}' does not have any commits yet\n`)
        : undefined;
    case "merge":
      return first === undefined || first.startsWith("-")
        ? undefined
        : { stdout: "", stderr: `merge: ${first} - not something we can merge\n`, exitCode: 1 };
    case "stash":
      return first === undefined || first === "push"
        ? {
            stdout: "",
            stderr: "You do not have the initial commit yet\n",
            exitCode: first === undefined ? 1 : 128,
          }
        : undefined;
    case "tag":
      return args.length === 1 && !(first ?? "-").startsWith("-")
        ? failure("fatal: Failed to resolve 'HEAD' as a valid ref.\n")
        : undefined;
    case "diff":
      return args.length === 1 && first === "HEAD" ? failure(AMBIGUOUS("HEAD")) : undefined;
    case "rev-parse":
      return args.length === 1 && first === "HEAD"
        ? { stdout: "HEAD\n", stderr: AMBIGUOUS("HEAD"), exitCode: 128 }
        : undefined;
    default:
      return undefined;
  }
}

export async function unbornCommand(
  command: string,
  client: GitClient,
  input: GitCliInput,
  scope: GitScope,
  files: WorkFiles,
): Promise<GitCliResult | undefined> {
  if (!UNBORN_COMMANDS.has(command) || (await resolves(client, scope.dir, "HEAD")) !== undefined)
    return undefined;

  const args = input.argv.slice(1);

  if (command === "reset") return resetUnborn(client, scope, files, args);

  if (command === "checkout" || command === "switch")
    return checkoutUnborn(client, scope, command, args);

  const branch = (await client.currentBranch({ dir: scope.dir })) ?? "HEAD";

  if (command === "show" && args[0] === "HEAD") return failure(AMBIGUOUS("HEAD"));

  return unbornResult(command, args, branch);
}
