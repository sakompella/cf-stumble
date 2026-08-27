import { Result, panic, type Result as ResultType } from "better-result";
import type { Sha } from "../git/types.js";
import type { StorageUnavailableError } from "../storage/errors.js";
import type { Store } from "../storage/types.js";
import { readGeneration } from "./read.js";
import type { CommitSnapshot } from "./types.js";

/** Walk from a commit through its parents, returning newest to oldest. */
export async function walkLineage(
  store: Store,
  start: Sha,
): Promise<ResultType<readonly CommitSnapshot[], StorageUnavailableError>> {
  const lineage: CommitSnapshot[] = [];
  // A genuine cycle is unconstructable here: a commit's sha is derived from bytes that already
  // embed its parent's sha, so a child cannot become its own ancestor. This guard defends against
  // a corrupted store instead, which is why no test covers the panic below.
  const visited = new Set<Sha>();
  let current = start;

  while (true) {
    if (visited.has(current)) {
      panic(`commit lineage cycle detected at ${current}`);
    }
    visited.add(current);

    const loaded = await readGeneration(store, current);
    if (Result.isError(loaded)) {
      return loaded;
    }
    const commit = loaded.value.generation;
    lineage.push(commit);
    if (commit.parent === undefined) {
      return Result.ok(lineage);
    }
    current = commit.parent;
  }
}
