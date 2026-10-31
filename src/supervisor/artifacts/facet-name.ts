export const SERVING_FACET_NAME = "main-facet:serving";

export function candidateFacetName(harnessCommit: string): string {
  return `main-facet:candidate:${harnessCommit}`;
}
