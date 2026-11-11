import type { GitClient, StatusEntry } from "@cloudflare/computer/git";
import type { ReadFile } from "./git-index-file.js";

export interface StatusLine {
  readonly path: string;
  readonly x: string;
  readonly y: string;
  readonly from?: string;
}

const ESCAPES = new Map([
  [7, "\\a"],
  [8, "\\b"],
  [9, "\\t"],
  [10, "\\n"],
  [11, "\\v"],
  [12, "\\f"],
  [13, "\\r"],
  [34, '\\"'],
  [92, "\\\\"],
]);

function plainByte(byte: number): boolean {
  return byte >= 0x20 && byte < 0x7f && !ESCAPES.has(byte);
}

export function quotePath(path: string): string {
  const bytes = new TextEncoder().encode(path);

  if (bytes.every(plainByte)) return path;

  const body = [...bytes].map(
    (byte) =>
      ESCAPES.get(byte) ??
      (plainByte(byte) ? String.fromCodePoint(byte) : `\\${byte.toString(8).padStart(3, "0")}`),
  );

  return `"${body.join("")}"`;
}

export function shownPath(line: StatusLine): string {
  return line.from === undefined
    ? quotePath(line.path)
    : `${quotePath(line.from)} -> ${quotePath(line.path)}`;
}

const SWAPPED = new Map([
  [" ", "M"],
  ["M", " "],
]);

async function exists(readFile: ReadFile, dir: string, path: string): Promise<boolean> {
  try {
    await readFile(`${dir.replace(/\/$/u, "")}/${path}`);

    return true;
  } catch {
    return false;
  }
}

async function correctedLines(
  entries: readonly StatusEntry[],
  present: (path: string) => Promise<boolean>,
): Promise<StatusLine[]> {
  const lines = await Promise.all(
    entries.map(async (entry): Promise<StatusLine[]> => {
      const { path, index, worktree } = entry;

      if (worktree === "?") return [{ path, x: "?", y: "?" }];

      if (index === "D" && (worktree === "M" || (worktree === " " && (await present(path)))))
        return [
          { path, x: "D", y: " " },
          { path, x: "?", y: "?" },
        ];

      const y = index === "A" || index === "M" ? SWAPPED.get(worktree) : undefined;

      return [{ path, x: index, y: y ?? worktree }];
    }),
  );

  return lines.flat();
}

function parentDirectories(path: string): string[] {
  const parts = path.split("/").slice(0, -1);

  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

function collapseUntracked(lines: readonly StatusLine[], tracked: readonly string[]): StatusLine[] {
  const trackedDirectories = new Set(tracked.flatMap(parentDirectories));
  const seen = new Set<string>();

  return lines.flatMap((line) => {
    if (line.x !== "?") return [line];

    const untrackedDirectory = parentDirectories(line.path).find(
      (directory) => !trackedDirectories.has(directory),
    );

    const path = untrackedDirectory === undefined ? line.path : `${untrackedDirectory}/`;

    if (seen.has(path)) return [];
    seen.add(path);

    return [{ ...line, path }];
  });
}

function trackedFirst(lines: readonly StatusLine[]): StatusLine[] {
  return [...lines.filter((line) => line.x !== "?"), ...lines.filter((line) => line.x === "?")];
}

export async function fileStatusLines(
  client: GitClient,
  dir: string,
  readFile: ReadFile,
): Promise<StatusLine[]> {
  const entries = await client.status({ dir });

  return trackedFirst(await correctedLines(entries, (path) => exists(readFile, dir, path)));
}

export async function statusLines(
  client: GitClient,
  dir: string,
  readFile: ReadFile,
): Promise<StatusLine[]> {
  const entries = await client.status({ dir });
  const corrected = await correctedLines(entries, (path) => exists(readFile, dir, path));
  const nested = corrected.some((line) => line.x === "?" && line.path.includes("/"));
  const lines = nested ? collapseUntracked(corrected, await client.lsFiles({ dir })) : corrected;

  return trackedFirst(lines);
}

export function shortStatus(lines: readonly StatusLine[]): string {
  return lines.map((line) => `${line.x}${line.y} ${shownPath(line)}\n`).join("");
}
