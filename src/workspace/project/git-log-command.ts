import type { CommitView, GitCliInput, GitCliResult, GitClient } from "@cloudflare/computer/git";
import type { GitScope } from "./git-cli.js";
import type { WorkFiles } from "./git-index-file.js";
import { renderLog, supportedSpec, type LogFormat } from "./git-log-format.js";
import { matching, resolveSpecs, WILDCARD } from "./git-pathspec.js";
import { failure } from "./git-result.js";
import { AMBIGUOUS, resolves } from "./git-revision.js";

interface LogRequest {
  readonly format: LogFormat;
  readonly limit: number | undefined;
  readonly words: readonly string[];
  readonly paths: readonly string[] | undefined;
}

interface Refusal {
  readonly refusal: GitCliResult;
}

type Parsed = LogRequest | Refusal;

function refusal(stderr: string, exitCode: number): Refusal {
  return { refusal: { stdout: "", stderr, exitCode } };
}

function unsupported(arg: string): Refusal {
  return refusal(`git log: unsupported option '${arg}'\n`, 129);
}

const NAMED = /^(?:short|medium|full|fuller|reference|email|raw|mboxrd)$/u;

function namedFormat(spec: string): LogFormat | undefined {
  if (spec === "oneline") return { kind: "custom", spec: "%H %s", separated: false };

  if (NAMED.test(spec)) return undefined;

  const separated = spec.startsWith("format:");
  const body = separated ? spec.slice("format:".length) : spec.replace(/^tformat:/u, "");

  return supportedSpec(body) ? { kind: "custom", spec: body, separated } : undefined;
}

function parseLog(args: readonly string[]): Parsed {
  let format: LogFormat = { kind: "full", spec: "", separated: false };
  let limit: number | undefined;
  const words: string[] = [];
  let paths: string[] | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";

    if (paths !== undefined) paths.push(arg);
    else if (arg === "--") paths = [];
    else if (arg === "--oneline") format = { kind: "oneline", spec: "", separated: false };
    else if (arg.startsWith("--format=") || arg.startsWith("--pretty=")) {
      const named = namedFormat(arg.slice(arg.indexOf("=") + 1));

      if (named === undefined) return unsupported(arg);

      format = named;
    } else if (arg === "-n" || arg.startsWith("-n") || /^-\d+$/u.test(arg)) {
      const text = arg === "-n" ? (args[++index] ?? "") : arg.replace(/^-n?/u, "");

      if (!/^\d+$/u.test(text)) return refusal(`fatal: '${text}': not an integer\n`, 128);

      limit = Number(text);
    } else if (arg.startsWith("-") && arg !== "-") return unsupported(arg);
    else words.push(arg);
  }

  return { format, limit, words, paths };
}

async function inWorktree(
  client: GitClient,
  files: WorkFiles,
  scope: GitScope,
  word: string,
): Promise<boolean> {
  const specs = resolveSpecs([word], scope.prefix);

  if ("outside" in specs) return false;

  const spec = specs[0] ?? ".";

  if (matching(await client.lsFiles({ dir: scope.dir }), spec).length > 0) return true;

  return files.read(`${scope.dir}/${spec}`).then(
    () => true,
    () => false,
  );
}

interface Classified {
  readonly start: string | undefined;
  readonly paths: readonly string[];
  readonly failure: GitCliResult | undefined;
}

async function classify(
  client: GitClient,
  files: WorkFiles,
  scope: GitScope,
  request: LogRequest,
): Promise<Classified> {
  let start: string | undefined;
  let pathsStarted = false;
  const paths = [...(request.paths ?? [])];

  for (const word of request.words) {
    const unsupportedForm = word.includes("..") || word.startsWith("^");
    const oid = unsupportedForm ? undefined : await resolves(client, scope.dir, word);

    if (unsupportedForm || (oid !== undefined && (start !== undefined || pathsStarted)))
      return {
        start,
        paths,
        failure: { stdout: "", stderr: `git log: unsupported revision '${word}'\n`, exitCode: 129 },
      };

    if (oid !== undefined) start = oid;
    else if (request.paths !== undefined)
      return { start, paths, failure: failure(`fatal: bad revision '${word}'\n`) };
    else if (await inWorktree(client, files, scope, word)) {
      paths.push(word);
      pathsStarted = true;
    } else return { start, paths, failure: failure(AMBIGUOUS(word)) };
  }

  return { start, paths, failure: undefined };
}

async function objectAt(
  client: GitClient,
  dir: string,
  commit: string,
  path: string,
): Promise<string | undefined> {
  try {
    return (await client.catFile({ dir, oid: commit, filepath: path })).oid;
  } catch {
    return undefined;
  }
}

type Entries = (commit: string, path: string) => Promise<string | undefined>;

function entries(client: GitClient, dir: string): Entries {
  const seen = new Map<string, string | undefined>();

  return async (commit, path) => {
    const key = `${commit}:${path}`;

    if (!seen.has(key)) seen.set(key, await objectAt(client, dir, commit, path));

    return seen.get(key);
  };
}

async function changedFiles(
  client: GitClient,
  dir: string,
  entry: Entries,
  spec: string,
  commit: string,
  parent: string | undefined,
): Promise<boolean> {
  const here = await client.lsFiles({ dir, ref: commit });
  const before = parent === undefined ? [] : await client.lsFiles({ dir, ref: parent });

  for (const path of matching([...new Set([...here, ...before])], spec))
    if (
      (await entry(commit, path)) !== (parent === undefined ? undefined : await entry(parent, path))
    )
      return true;

  return false;
}

async function differs(
  client: GitClient,
  dir: string,
  entry: Entries,
  specs: readonly string[],
  commit: string,
  parent: string | undefined,
): Promise<boolean> {
  for (const spec of specs) {
    if (WILDCARD.test(spec)) {
      if (await changedFiles(client, dir, entry, spec, commit, parent)) return true;
    } else if (
      spec === "."
        ? (await client.show({ dir, ref: commit })).tree !==
          (parent === undefined ? undefined : (await client.show({ dir, ref: parent })).tree)
        : (await entry(commit, spec)) !==
          (parent === undefined ? undefined : await entry(parent, spec))
    )
      return true;
  }

  return false;
}

async function touching(
  client: GitClient,
  dir: string,
  commits: readonly CommitView[],
  specs: readonly string[],
  limit: number | undefined,
): Promise<readonly CommitView[]> {
  const entry = entries(client, dir);
  const picked: CommitView[] = [];

  for (const commit of commits) {
    if (limit !== undefined && picked.length >= limit) break;

    const parents = commit.parent.length === 0 ? [undefined] : commit.parent;
    let all = true;

    for (const parent of parents)
      if (all) all = await differs(client, dir, entry, specs, commit.oid, parent);

    if (all) picked.push(commit);
  }

  return picked;
}

export async function logCommand(
  client: GitClient,
  input: GitCliInput,
  scope: GitScope,
  files: WorkFiles,
): Promise<GitCliResult> {
  const request = parseLog(input.argv.slice(1));

  if ("refusal" in request) return request.refusal;

  const classified = await classify(client, files, scope, request);

  if (classified.failure !== undefined) return classified.failure;

  const head = classified.start ?? (await resolves(client, scope.dir, "HEAD"));

  if (head === undefined)
    return failure(
      `fatal: your current branch '${(await client.currentBranch({ dir: scope.dir })) ?? "HEAD"}' does not have any commits yet\n`,
    );

  const specs = resolveSpecs(classified.paths, scope.prefix);

  if ("outside" in specs)
    return failure(`fatal: '${specs.outside}': no such path in the working tree.\n`);

  const commits =
    specs.length === 0 && request.limit !== undefined
      ? await client.log({ dir: scope.dir, ref: head, depth: request.limit })
      : await client.log({ dir: scope.dir, ref: head });

  const distinct = commits.filter(
    (commit, index) => commits.findIndex((other) => other.oid === commit.oid) === index,
  );

  const chosen =
    specs.length === 0
      ? distinct.slice(0, request.limit)
      : await touching(client, scope.dir, distinct, specs, request.limit);

  return { stdout: renderLog(chosen, request.format), stderr: "", exitCode: 0 };
}
