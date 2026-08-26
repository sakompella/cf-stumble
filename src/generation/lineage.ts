import type { Sha } from "../git/types.js";
import type { Store } from "../storage/types.js";
import { readGeneration } from "./read.js";
import type { Generation } from "./types.js";

/** Walk from a generation toward generation 0, returning newest to oldest. */
export async function walkLineage(
  store: Store,
  start: Sha,
): Promise<readonly Generation[]> {
  const lineage: Generation[] = [];
  const visited = new Set<Sha>();
  let current = start;

  while (true) {
    if (visited.has(current)) {
      throw new Error(`generation lineage cycle detected at ${current}`);
    }
    visited.add(current);

    const { generation } = await readGeneration(store, current);
    lineage.push(generation);
    if (generation.parent === undefined) {
      return lineage;
    }
    current = generation.parent;
  }
}
