export const SERVING_FACET_NAME = "main-facet:serving";

export function servingLoaderName(harnessCommit: string, instance: number): string {
  return `${harnessCommit}:serving:${instance}`;
}

export function candidateFacetName(harnessCommit: string): string {
  return `main-facet:candidate:${harnessCommit}`;
}
