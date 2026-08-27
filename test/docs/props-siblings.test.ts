import { describe, expect, it } from "vitest";

/**
 * ADR-0008 lets property tests run in Node because hegel's generation engine is native code that
 * workerd cannot load. What keeps that from becoming a second test population is one rule: Node
 * only ever adds a generative layer over a module workerd already covers, so a green Node run can
 * never be the only evidence a module works. Stated as a convention that rule decays silently —
 * nobody notices the day a `.props.test.ts` lands without a sibling — so it is a test instead.
 *
 * This test runs in workerd, which is the point: the guard has to hold even when the Node project
 * is skipped or broken. Vite resolves the glob at build time, so it reads no filesystem.
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
const propertyTests = import.meta.glob("../**/*.props.test.ts", {
  eager: true,
  query: "?raw",
  import: "default",
});
const allTests = import.meta.glob("../**/*.test.ts", {
  eager: true,
  query: "?raw",
  import: "default",
});

// The glob above also matches the property tests, which the workers project excludes.
const workerdTests = new Set(
  Object.keys(allTests).filter((path) => !path.endsWith(".props.test.ts")),
);

/** `.../git/oracle.props.test.ts` -> `.../git/oracle.test.ts`, the file that must exist. */
function siblingPath(propertyTestPath: string): string {
  return propertyTestPath.replace(/\.props\.test\.ts$/u, ".test.ts");
}

describe("property tests in the Node project", () => {
  it("finds property tests to check", () => {
    expect(Object.keys(propertyTests).length).toBeGreaterThan(0);
  });

  it("never carry a module's only coverage", () => {
    const orphans = Object.keys(propertyTests)
      .filter((path) => !workerdTests.has(siblingPath(path)))
      .toSorted();

    expect(
      orphans,
      "each of these needs a sibling .test.ts running in workerd; properties supplement workerd coverage, they never replace it",
    ).toEqual([]);
  });
});
