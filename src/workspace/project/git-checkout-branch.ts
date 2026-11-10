import type { GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import { invalidName } from "./git-branch-create.js";
import type { GitScope } from "./git-cli.js";
import { failure } from "./git-result.js";
import { resolves } from "./git-revision.js";

const CREATE = new Map([
  ["-b", false],
  ["-c", false],
  ["-B", true],
  ["-C", true],
]);

type Switch =
  | { readonly kind: "detach"; readonly start: string | undefined }
  | {
      readonly kind: "create";
      readonly name: string;
      readonly start: string | undefined;
      readonly force: boolean;
    };

function switchRequest(args: readonly string[]): Switch | undefined {
  const flags = args.filter((arg) => arg.startsWith("-"));
  const words = args.filter((arg) => !arg.startsWith("-"));

  if (args.includes("--") || flags.length !== 1) return undefined;

  const [flag = ""] = flags;

  if (flag === "--detach")
    return words.length > 1 ? undefined : { kind: "detach", start: words[0] };

  const force = CREATE.get(flag);

  if (force === undefined || args[0] !== flag || words.length === 0 || words.length > 2)
    return undefined;

  return { kind: "create", name: words[0] ?? "", start: words[1], force };
}

function subject(message: string): string {
  return message.split("\n")[0] ?? "";
}

async function detach(
  client: GitClient,
  dir: string,
  command: string,
  start: string | undefined,
): Promise<GitCliResult> {
  const oid = await resolves(client, dir, start ?? "HEAD");

  if (
    oid === undefined ||
    (start === undefined && (await client.currentBranch({ dir })) === undefined)
  )
    return failure(
      command === "switch"
        ? `fatal: invalid reference: ${start ?? "HEAD"}\n`
        : `fatal: git checkout: --detach does not take a path argument '${start ?? "HEAD"}'\n`,
    );

  await client.checkout({ dir, ref: oid });

  const commit = await client.show({ dir, ref: oid });

  return {
    stdout: "",
    stderr: `HEAD is now at ${oid.slice(0, 7)} ${subject(commit.message)}\n`,
    exitCode: 0,
  };
}

async function create(
  client: GitClient,
  dir: string,
  command: string,
  request: Extract<Switch, { kind: "create" }>,
): Promise<GitCliResult | undefined> {
  const { name, start, force } = request;

  if (start === undefined && (await resolves(client, dir, "HEAD")) === undefined) return undefined;

  const invalid = invalidName(name);

  if (invalid !== undefined) return invalid;

  const exists = (await client.branchList({ dir })).includes(name);

  if (exists && !force) return failure(`fatal: a branch named '${name}' already exists\n`);

  const oid = await resolves(client, dir, start ?? "HEAD");

  if (oid === undefined)
    return failure(
      command === "switch"
        ? `fatal: invalid reference: ${start ?? "HEAD"}\n`
        : `fatal: '${start ?? "HEAD"}' is not a commit and a branch '${name}' cannot be created from it\n`,
    );

  const current = await client.currentBranch({ dir });

  await client.branch({ dir, name, startPoint: oid, force });
  await client.checkout({ dir, ref: name });

  const verb = exists
    ? current === name
      ? "Reset branch"
      : "Switched to and reset branch"
    : "Switched to a new branch";

  return { stdout: "", stderr: `${verb} '${name}'\n`, exitCode: 0 };
}

export function branchSwitch(
  client: GitClient,
  input: GitCliInput,
  scope: GitScope,
): Promise<GitCliResult | undefined> | undefined {
  const request = switchRequest(input.argv.slice(1));
  const command = input.argv[0] ?? "checkout";

  if (request === undefined) return undefined;

  return request.kind === "detach"
    ? detach(client, scope.dir, command, request.start)
    : create(client, scope.dir, command, request);
}
