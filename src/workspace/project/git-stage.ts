import type { GitClient } from "@cloudflare/computer/git";
import { matchesAny } from "./git-pathspec.js";
import type { StatusLine } from "./git-status.js";

export interface Selection {
  readonly changed: readonly string[];
  readonly deleted: readonly string[];
}

function bare(path: string): string {
  return path.replace(/\/$/u, "");
}

export function changeSelection(lines: readonly StatusLine[], specs: readonly string[]): Selection {
  const pending = lines.filter((line) => matchesAny(bare(line.path), specs) && line.y !== " ");

  return {
    changed: pending.flatMap((line) => (line.y === "D" ? [] : [bare(line.path)])),
    deleted: pending.flatMap((line) => (line.y === "D" ? [line.path] : [])),
  };
}

export async function stage(
  client: GitClient,
  dir: string,
  selection: Selection,
  force: boolean,
): Promise<void> {
  if (selection.changed.length > 0) await client.add({ dir, paths: [...selection.changed], force });

  if (selection.deleted.length > 0) await client.rm({ dir, paths: [...selection.deleted] });
}
