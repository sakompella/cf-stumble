import { describe, expect, it } from "vitest";

/**
 * The repo has twice deleted a decision register that drifted out of date. An index of ADRs is
 * the same shape of risk: it is only useful while it is complete, and nothing about writing a
 * new ADR forces anyone to add a line to it.
 *
 * Vite resolves both globs at build time, so this reads no filesystem and runs in workerd.
 */
declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { readonly eager: true; readonly query: "?raw"; readonly import: "default" },
    ) => Record<string, string>;
  }
}

// Vite rewrites these calls at build time, so both option objects have to be inline literals.
const adrFiles = import.meta.glob("../../docs/adr/[0-9]*.md", {
  eager: true,
  query: "?raw",
  import: "default",
});
const indexFiles = import.meta.glob("../../docs/adr/README.md", {
  eager: true,
  query: "?raw",
  import: "default",
});

function basename(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash < 0 ? path : path.slice(lastSlash + 1);
}

describe("the ADR index", () => {
  const index = Object.values(indexFiles)[0];

  it("finds an index and some ADRs to check it against", () => {
    expect(index).toBeDefined();
    expect(Object.keys(adrFiles).length).toBeGreaterThan(0);
  });

  it("links every ADR", () => {
    const linked = index ?? "";
    const missing = Object.keys(adrFiles)
      .map((path) => basename(path))
      .filter((file) => !linked.includes(`(${file})`))
      .toSorted();

    expect(missing, "add these to docs/adr/README.md").toEqual([]);
  });
});
