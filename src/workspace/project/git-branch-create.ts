import type { GitCliResult, GitClient } from "@cloudflare/computer/git";
import { failure, OK } from "./git-result.js";
import { resolves } from "./git-revision.js";

export interface BranchCreation {
  readonly name: string;
  readonly start: string | undefined;
  readonly force: boolean;
}

const FORCE = new Set(["-f", "--force"]);

const INVALID_NAME = /[~^:?*[\\]|\.\.|@\{|\/\/|^\/|\/$|\.$|\.lock(?:\/|$)|(?:^|\/)\./u;

const LAST_CONTROL = 0x20;

const DELETE = 0x7f;

function validName(name: string): boolean {
  const controlled = Array.from({ length: name.length }, (_, at) => name.codePointAt(at) ?? 0).some(
    (code) => code <= LAST_CONTROL || code === DELETE,
  );

  return !controlled && !INVALID_NAME.test(name) && name !== "HEAD";
}

const REF_SYNTAX_HINT =
  "hint: See 'git help check-ref-format'\nhint: Disable this message with \"git config set advice.refSyntax false\"\n";

export function invalidName(name: string): GitCliResult | undefined {
  return validName(name)
    ? undefined
    : failure(`fatal: '${name}' is not a valid branch name\n${REF_SYNTAX_HINT}`);
}

export function creationRequest(args: readonly string[]): BranchCreation | undefined {
  const force = args.some((arg) => FORCE.has(arg));
  const words = args.filter((arg) => !FORCE.has(arg));

  if (words.length === 0 || words.length > 2 || words.some((word) => word.startsWith("-")))
    return undefined;

  return { name: words[0] ?? "", start: words[1], force };
}

export async function createBranch(
  client: GitClient,
  dir: string,
  request: BranchCreation,
): Promise<GitCliResult> {
  const { name, start, force } = request;

  const invalid = invalidName(name);

  if (invalid !== undefined) return invalid;

  const existing = (await client.branchList({ dir })).includes(name);

  if (existing && !force) return failure(`fatal: a branch named '${name}' already exists\n`);

  if (existing && (await client.currentBranch({ dir })) === name)
    return failure(
      `fatal: cannot force update the branch '${name}' used by worktree at '${dir}'\n`,
    );

  const oid = await resolves(client, dir, start ?? "HEAD");

  if (oid === undefined) {
    const shown = start ?? (await client.currentBranch({ dir })) ?? "HEAD";

    return failure(`fatal: not a valid object name: '${shown}'\n`);
  }

  await client.branch({ dir, name, startPoint: oid, force });

  return OK;
}
