import type { Sha } from "../git/types.js";
import type { Store } from "../storage/types.js";
import { readGeneration } from "./read.js";
import type { CommitSnapshot } from "./types.js";

/** Walk from a commit through its parents, returning newest to oldest. */
export async function walkLineage(store: Store, start: Sha): Promise<readonly CommitSnapshot[]> {
  const lineage: CommitSnapshot[] = [];
  // A genuine cycle is unconstructable here: a commit's sha is derived from bytes that already
  // embed its parent's sha, so a child cannot become its own ancestor. This guard defends against
  // a corrupted store instead, which is why no test covers the throw below.
  const visited = new Set<Sha>();
  let current = start;

  while (true) {
    if (visited.has(current)) {
      throw new Error(`commit lineage cycle detected at ${current}`);
    }
    visited.add(current);

    const { generation: commit } = await readGeneration(store, current);
    lineage.push(commit);
    if (commit.parent === undefined) {
      return lineage;
    }
    current = commit.parent;
  }
}
