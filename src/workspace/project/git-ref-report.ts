import type { GitClient } from "@cloudflare/computer/git";
import type { WorkFiles } from "./git-index-file.js";

export type RemoteBranches = ReadonlyMap<string, string>;

const SUMMARY_WIDTH = 17;

const ABBREVIATION = 7;

const MINIMUM_REF_WIDTH = 10;

async function listed(files: WorkFiles, root: string): Promise<readonly string[]> {
  try {
    return await files.list(root);
  } catch {
    return [];
  }
}

export async function remoteBranches(
  client: GitClient,
  files: WorkFiles,
  dir: string,
  remote: string,
): Promise<RemoteBranches> {
  const root = `${dir}/.git/refs/remotes/${remote}`;
  const names = await listed(files, root);
  const branches = new Map<string, string>();

  for (const name of names.filter((known) => known !== "HEAD").toSorted()) {
    const oid = await client.revParse({ dir, ref: `refs/remotes/${remote}/${name}` });

    branches.set(name, oid);
  }

  return branches;
}

export async function nonFastForward(
  client: GitClient,
  dir: string,
  before: RemoteBranches,
  after: RemoteBranches,
): Promise<ReadonlySet<string>> {
  const forced = new Set<string>();

  for (const [name, next] of after) {
    const old = before.get(name);

    if (old === undefined || old === next) continue;

    const history = await client.log({ dir, ref: next });

    if (!history.some((commit) => commit.oid === old)) forced.add(name);
  }

  return forced;
}

function short(oid: string): string {
  return oid.slice(0, ABBREVIATION);
}

function row(flag: string, summary: string, rest: string): string {
  return ` ${flag} ${summary.padEnd(SUMMARY_WIDTH)} ${rest}\n`;
}

export interface Pushed {
  readonly from: string;
  readonly to: string;
}

export interface PushOutcome {
  readonly before: RemoteBranches;
  readonly after: RemoteBranches;
  readonly forced: ReadonlySet<string>;
}

export function pushReport(url: string, pushed: readonly Pushed[], outcome: PushOutcome): string {
  const touched = pushed.filter(({ to }) => outcome.before.has(to) || outcome.after.has(to));

  const rows = touched.map(({ from, to }) => {
    const old = outcome.before.get(to);
    const next = outcome.after.get(to);

    if (next === undefined) return { changed: true, text: row("-", "[deleted]", to) };

    const names = `${from} -> ${to}`;

    if (old === undefined) return { changed: true, text: row("*", "[new branch]", names) };

    if (old === next) return { changed: false, text: row("=", "[up to date]", names) };

    if (outcome.forced.has(to))
      return {
        changed: true,
        text: row("+", `${short(old)}...${short(next)}`, `${names} (forced update)`),
      };

    return { changed: true, text: row(" ", `${short(old)}..${short(next)}`, names) };
  });

  if (rows.length === 0) return "";

  if (rows.every((entry) => !entry.changed)) return "Everything up-to-date\n";

  return `To ${url}\n${rows.map((entry) => entry.text).join("")}`;
}

export interface FetchOutcome {
  readonly before: RemoteBranches;
  readonly after: RemoteBranches;
  readonly forced: ReadonlySet<string>;
  readonly requested: string | undefined;
}

export function fetchReport(url: string, remote: string, outcome: FetchOutcome): string {
  const changed = [...outcome.after].filter(([name, oid]) => outcome.before.get(name) !== oid);
  const requested = outcome.requested;

  const width = Math.max(
    MINIMUM_REF_WIDTH,
    ...changed.map(([name]) => name.length),
    requested?.length ?? 0,
  );

  const rows = changed.map(([name, oid]) => {
    const old = outcome.before.get(name);
    const names = `${name.padEnd(width)} -> ${remote}/${name}`;

    if (old === undefined) return row("*", "[new branch]", names);

    if (outcome.forced.has(name))
      return row("+", `${short(old)}...${short(oid)}`, `${names}  (forced update)`);

    return row(" ", `${short(old)}..${short(oid)}`, names);
  });

  const head =
    requested === undefined ? [] : [row("*", "branch", `${requested.padEnd(width)} -> FETCH_HEAD`)];

  const lines = requested === undefined ? rows : [...head, ...rows];

  return lines.length === 0 ? "" : `From ${url}\n${lines.join("")}`;
}
