import { describe, expect, it } from "vitest";

/**
 * Production must not depend on a test fixture. The Supervisor used to seed Generation 0 from
 * `fixtureMainHarnessCommit` in its constructor and to serve `fixtureMainHarnessArtifact` whenever
 * no generation was active. Generation 0 is now an ordinary owner submission of the deployed
 * harness commit, so no file under src/ may reach the fixture again, however indirectly.
 *
 * Vite resolves the globs at build time, so this reads no filesystem and runs in workerd.
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

const testFiles = import.meta.glob("../**/*.ts", {
  eager: true,
  query: "?raw",
  import: "default",
});

const FIXTURE_PATH = "src/facet/fixture.ts";

const importPattern = /from\s+"(\.[^"]*)"/gu;

function repoPath(globKey: string, prefix: string): string {
  return globKey.replace(/^(?:\.\.\/)+/u, prefix);
}

function directoryOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

function resolveImport(fromDirectory: string, specifier: string): string {
  const resolved: string[] = [];
  for (const segment of [...fromDirectory.split("/"), ...specifier.split("/")]) {
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

function importersOfFixture(files: Record<string, string>, prefix: string): string[] {
  const found: string[] = [];
  for (const [globKey, contents] of Object.entries(files)) {
    const importer = repoPath(globKey, prefix);
    if (importer === FIXTURE_PATH) {
      continue;
    }
    const specifiers = [...contents.matchAll(importPattern)].map((match) => match[1] ?? "");
    if (
      specifiers.some(
        (specifier) => resolveImport(directoryOf(importer), specifier) === FIXTURE_PATH,
      )
    ) {
      found.push(importer);
    }
  }

  return found.toSorted();
}

describe("the main-harness fixture stays out of production", () => {
  it("finds the source files and the fixture among them", () => {
    expect(Object.keys(sourceFiles).length).toBeGreaterThan(20);
    expect(Object.keys(sourceFiles).map((key) => repoPath(key, ""))).toContain(FIXTURE_PATH);
  });

  it("resolves an import specifier against the importing directory", () => {
    expect(resolveImport("src/supervisor/artifacts", "../../facet/fixture.js")).toBe(FIXTURE_PATH);
    expect(resolveImport("src/facet", "./index.js")).toBe("src/facet/index.ts");
  });

  it("lets no file under src/ import the fixture", () => {
    expect(
      importersOfFixture(sourceFiles, ""),
      "production must submit and build a real harness commit instead",
    ).toEqual([]);
  });

  it("keeps the fixture available to tests", () => {
    expect(importersOfFixture(testFiles, "test/").length).toBeGreaterThan(0);
  });
});
