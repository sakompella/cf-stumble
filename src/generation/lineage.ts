import type { Sha } from "../git/types.js";
import type { Store } from "../storage/types.js";
import { readGeneration } from "./read.js";
import type { CommitSnapshot } from "./types.js";

/** Walk from a commit through its parents, returning newest to oldest. */
export async function walkLineage(store: Store, start: Sha): Promise<readonly CommitSnapshot[]> {
  const lineage: CommitSnapshot[] = [];
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
