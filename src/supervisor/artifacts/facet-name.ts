export function mainFacetName(harnessCommit: string, role: "serving" | "candidate"): string {
  return `main-facet:${role}:${harnessCommit}`;
}
