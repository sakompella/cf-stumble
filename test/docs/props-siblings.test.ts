import { describe, expect, it } from "vitest";

declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { readonly eager: true; readonly query: "?raw"; readonly import: "default" },
    ) => Record<string, string>;
  }
}

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

function siblingPath(propertyTestPath: string): string {
  return propertyTestPath.replace(/\.props\.test\.ts$/u, ".test.ts");
}

describe("Node property-test coverage", () => {
  it("discovers at least one property test", () => {
    expect(Object.keys(propertyTests).length).toBeGreaterThan(0);
  });

  it("keeps every property beside workerd coverage", () => {
    const workerdTests = new Set(
      Object.keys(allTests).filter((path) => !path.endsWith(".props.test.ts")),
    );
    const orphans = Object.keys(propertyTests)
      .filter((path) => !workerdTests.has(siblingPath(path)))
      .toSorted();

    expect(orphans).toEqual([]);
  });
});
