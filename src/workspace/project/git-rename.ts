import type { GitClient } from "@cloudflare/computer/git";
import { parseIndex, type IndexEntry, type ReadFile } from "./git-index-file.js";
import { MINIMUM_SCORE, similarity } from "./git-rename-similarity.js";
import type { StatusLine } from "./git-status.js";

const RENAME_LIMIT = 1000;

const REGULAR_MODES = new Set(["100644", "100755"]);

const SYMLINK_MODE = "120000";

interface Blob {
  readonly path: string;
  readonly oid: string;
  readonly mode: string;
}

interface Candidate {
  readonly source: Blob;
  readonly target: Blob;
  readonly score: number;
  readonly sameName: boolean;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function compatible(source: Blob, target: Blob): boolean {
  return (
    source.mode === target.mode ||
    (REGULAR_MODES.has(source.mode) && REGULAR_MODES.has(target.mode))
  );
}

function convertible(blob: Blob): boolean {
  return REGULAR_MODES.has(blob.mode) || blob.mode === SYMLINK_MODE;
}

async function headBlobs(client: GitClient, dir: string, paths: readonly string[]) {
  const directories = new Map<string, Map<string, IndexEntry>>();
  const blobs: Blob[] = [];

  for (const path of paths) {
    const at = path.lastIndexOf("/");
    const directory = at < 0 ? "" : path.slice(0, at);

    if (!directories.has(directory)) {
      const entries = await client.lsTree({ dir, ref: "HEAD", path: directory });

      directories.set(
        directory,
        new Map(entries.map((entry) => [entry.path, { oid: entry.oid, mode: entry.mode }])),
      );
    }

    const entry = directories.get(directory)?.get(basename(path));

    if (entry !== undefined) blobs.push({ path, ...entry });
  }

  return blobs.filter(convertible);
}

function exactPairs(sources: readonly Blob[], targets: readonly Blob[]): Map<string, Blob> {
  const pairs = new Map<string, Blob>();
  const used = new Set<string>();

  for (const target of targets) {
    const matches = sources.filter(
      (source) => !used.has(source.path) && source.oid === target.oid && compatible(source, target),
    );

    const best =
      matches.find((source) => basename(source.path) === basename(target.path)) ?? matches[0];

    if (best === undefined) continue;

    used.add(best.path);
    pairs.set(target.path, best);
  }

  return pairs;
}

async function contents(client: GitClient, dir: string, blobs: readonly Blob[]) {
  const loaded = new Map<string, Uint8Array>();

  for (const blob of blobs)
    loaded.set(blob.path, (await client.catFile({ dir, oid: blob.oid })).bytes);

  return loaded;
}

async function inexactPairs(
  client: GitClient,
  dir: string,
  sources: readonly Blob[],
  targets: readonly Blob[],
): Promise<Map<string, Blob>> {
  const pairs = new Map<string, Blob>();

  if (sources.length === 0 || targets.length === 0) return pairs;

  if (sources.length * targets.length > RENAME_LIMIT * RENAME_LIMIT) return pairs;

  const [sourceBytes, targetBytes] = await Promise.all([
    contents(client, dir, sources),
    contents(client, dir, targets),
  ]);

  const candidates: Candidate[] = [];

  for (const target of targets)
    for (const source of sources) {
      if (!compatible(source, target)) continue;

      const score = similarity(
        sourceBytes.get(source.path) ?? new Uint8Array(),
        targetBytes.get(target.path) ?? new Uint8Array(),
      );

      if (score >= MINIMUM_SCORE)
        candidates.push({
          source,
          target,
          score,
          sameName: basename(source.path) === basename(target.path),
        });
    }

  const usedSources = new Set<string>();

  for (const candidate of candidates.toSorted(
    (a, b) => b.score - a.score || Number(b.sameName) - Number(a.sameName),
  )) {
    if (pairs.has(candidate.target.path) || usedSources.has(candidate.source.path)) continue;

    pairs.set(candidate.target.path, candidate.source);
    usedSources.add(candidate.source.path);
  }

  return pairs;
}

export async function withRenames(
  client: GitClient,
  dir: string,
  readFile: ReadFile,
  lines: readonly StatusLine[],
): Promise<StatusLine[]> {
  const deleted = lines.flatMap((line) => (line.x === "D" ? [line.path] : []));
  const added = lines.flatMap((line) => (line.x === "A" ? [line.path] : []));

  if (deleted.length === 0 || added.length === 0) return [...lines];

  const index = parseIndex(await readFile(`${dir.replace(/\/$/u, "")}/.git/index`));

  const targets = added.flatMap((path): Blob[] => {
    const entry = index.get(path);

    return entry === undefined ? [] : [{ path, ...entry }];
  });

  const sources = await headBlobs(client, dir, deleted);
  const exact = exactPairs(sources, targets.filter(convertible));
  const matchedSources = new Set([...exact.values()].map((source) => source.path));

  const inexact = await inexactPairs(
    client,
    dir,
    sources.filter((source) => !matchedSources.has(source.path)),
    targets.filter((target) => convertible(target) && !exact.has(target.path)),
  );

  const renames = new Map([...exact, ...inexact]);
  const renamedSources = new Set([...renames.values()].map((source) => source.path));

  return lines.flatMap((line): StatusLine[] => {
    if (line.x === "D" && renamedSources.has(line.path)) return [];

    const source = line.x === "A" ? renames.get(line.path) : undefined;

    return [source === undefined ? line : { ...line, x: "R", from: source.path }];
  });
}
