import { describe, expect, it } from "vitest";

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

const publicEntrypoints = new Set([
  "src/workspace/project/protocol.ts",
  "src/supervisor/conversations/conversation-result.ts",
  "src/supervisor/projects/turn-frames.ts",
]);

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
  it("routes every cross-group import through the group's index", () => {
    expect(violations(), "import these through the directory's index.ts").toEqual([]);
  });
});
