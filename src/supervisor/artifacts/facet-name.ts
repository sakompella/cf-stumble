/**
 * Every generation serves under this one name, so Pi Durable's session in the facet's own storage
 * outlives a generation change. Activation and rollback abort it; nothing ever deletes it.
 */
export const SERVING_FACET_NAME = "main-facet:serving";

/** A candidate has storage of its own, apart from the serving facet's. */
export function candidateFacetName(harnessCommit: string): string {
  return `main-facet:candidate:${harnessCommit}`;
}
