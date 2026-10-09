import { writeModuleMap, type ModuleMapBuild } from "./module-map-build.mts";

/**
 * Builds each test-only Worker Loader entrypoint into the same `{ entryModule, modules }`
 * module-map shape `tools/build-generation-0.mts` writes, so the loaded-isolate tests can load
 * them the same way `test/facet/generation-0/module-map.test.ts` loads the built main facet.
 *
 * These are test fixtures, not harness artifacts: they carry no labeled commit and are never read
 * by the Supervisor. The output lives under the gitignored `build/` directory alongside
 * `build/module-map.json`.
 */

const FIXTURES: readonly ModuleMapBuild[] = [
  {
    entryPoint: "test/facet/generation-0/loaded-execution-env-entry.ts",
    entryModule: "loaded-execution-env-entry.js",
    outputPath: "build/loaded-execution-env-fixture.json",
  },
  {
    entryPoint: "test/facet/generation-0/loaded-facet-turn-entry.ts",
    entryModule: "loaded-facet-turn-entry.js",
    outputPath: "build/loaded-facet-turn-fixture.json",
  },
  {
    entryPoint: "test/supervisor/projects/loaded-project-workspaces-entry.ts",
    entryModule: "loaded-project-workspaces-entry.js",
    outputPath: "build/loaded-project-workspaces-fixture.json",
  },
];

for (const fixture of FIXTURES) {
  await writeModuleMap(fixture);
}
