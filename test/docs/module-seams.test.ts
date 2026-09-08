import { describe, expect, it } from "vitest";

/**
 * Each directory under src/ that has an index.ts states what the rest of the program may use.
 * Nothing enforced that, so an import could reach past an index into a group's internals and the
 * grouping would decay back into the flat layout it replaced.
 *
 * Vite resolves the glob at build time, so this reads no filesystem and runs in workerd.
 */
declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { readonly eager: true; readonly query: "?raw"; readonly import: "default" },
    ) => Record<string, string>;
  }
}

const sourceFiles = import.meta.glob("../../src/**/*.ts", {
  eager: true,
  query: "?raw",
  import: "default",
});

const importPattern = /from\s+"(\.[^"]*)"/gu;

function repoPath(globKey: string): string {
  return globKey.replace(/^(?:\.\.\/)+/u, "");
}

function directoryOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

function resolveImport(fromDirectory: string, specifier: string): string {
  const segments = [...fromDirectory.split("/"), ...specifier.split("/")];
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "." || segment === "") {
      continue;
    }
    if (segment === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }

  return resolved.join("/").replace(/\.js$/u, ".ts");
}

function importsOf(contents: string): string[] {
  return [...contents.matchAll(importPattern)].map((match) => match[1] ?? "");
}

const groupDirectories = Object.keys(sourceFiles)
  .map((key) => repoPath(key))
  .filter((path) => path.endsWith("/index.ts"))
  .map((path) => directoryOf(path));

const publicEntrypoints = new Set(["src/workspace/project/protocol.ts"]);

function violations(): string[] {
  const found: string[] = [];
  for (const [globKey, contents] of Object.entries(sourceFiles)) {
    const importer = repoPath(globKey);
    const importerDirectory = directoryOf(importer);
    for (const specifier of importsOf(contents)) {
      const target = resolveImport(importerDirectory, specifier);
      for (const group of groupDirectories) {
        const insideGroup =
          importerDirectory === group || importerDirectory.startsWith(`${group}/`);
        const reachesIn =
          target.startsWith(`${group}/`) &&
          target !== `${group}/index.ts` &&
          !publicEntrypoints.has(target);
        if (reachesIn && !insideGroup) {
          found.push(`${importer} imports ${target}, not ${group}/index.ts`);
        }
      }
    }
  }

  return found.toSorted();
}

describe("module seams", () => {
  it("finds the source files and their group directories", () => {
    expect(Object.keys(sourceFiles).length).toBeGreaterThan(20);
    expect(groupDirectories).toContain("src/supervisor/generations");
  });

  it("resolves import specifiers against the importing directory", () => {
    expect(resolveImport("src/supervisor/generations", "./preparation-checks.js")).toBe(
      "src/supervisor/generations/preparation-checks.ts",
    );
    expect(resolveImport("src/supervisor/generations", "../../workspace-names.js")).toBe(
      "src/workspace-names.ts",
    );
  });

  it("routes every cross-group import through the group's index", () => {
    expect(violations(), "import these through the directory's index.ts").toEqual([]);
  });
});
