import type { GitClient, StatusEntry } from "@cloudflare/computer/git";

export interface StatusLine {
  readonly path: string;
  readonly x: string;
  readonly y: string;
  readonly from?: string;
}

export function shownPath(line: StatusLine): string {
  return line.from === undefined ? line.path : `${line.from} -> ${line.path}`;
}

const SWAPPED = new Map([
  [" ", "M"],
  ["M", " "],
]);

function correctedLines(entries: readonly StatusEntry[]): StatusLine[] {
  return entries.flatMap((entry): StatusLine[] => {
    const { path, index, worktree } = entry;

    if (worktree === "?") return [{ path, x: "?", y: "?" }];

    if (index === "D" && worktree === "M")
      return [
        { path, x: "D", y: " " },
        { path, x: "?", y: "?" },
      ];

    const y = index === "A" || index === "M" ? SWAPPED.get(worktree) : undefined;

    return [{ path, x: index, y: y ?? worktree }];
  });
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

export async function statusLines(client: GitClient, dir: string): Promise<StatusLine[]> {
  const corrected = correctedLines(await client.status({ dir }));
  const nested = corrected.some((line) => line.x === "?" && line.path.includes("/"));
  const lines = nested ? collapseUntracked(corrected, await client.lsFiles({ dir })) : corrected;

  return [...lines.filter((line) => line.x !== "?"), ...lines.filter((line) => line.x === "?")];
}

export function shortStatus(lines: readonly StatusLine[]): string {
  return lines.map((line) => `${line.x}${line.y} ${shownPath(line)}\n`).join("");
}
