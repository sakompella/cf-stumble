import { expect, test } from "vitest";

declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { readonly eager: true; readonly query: "?raw"; readonly import: "default" },
    ) => Record<string, string>;
  }
}

const adrFiles = import.meta.glob("../../docs/agents/adr/[0-9]*.md", {
  eager: true,
  query: "?raw",
  import: "default",
});

const index = Object.values(
  import.meta.glob("../../docs/agents/adr/README.md", {
    eager: true,
    query: "?raw",
    import: "default",
  }),
)[0];

test("the ADR index links every ADR", () => {
  const missing = Object.keys(adrFiles)
    .map((path) => path.slice(path.lastIndexOf("/") + 1))
    .filter((file) => index?.includes(`(${file})`) !== true);

  expect(index).toBeDefined();
  expect(missing).toEqual([]);
});
