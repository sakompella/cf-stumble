import { writeModuleMap, type ModuleMapBuild } from "./module-map-build.mts";

const FIXTURES: readonly ModuleMapBuild[] = [
  {
    entryPoint: "test/supervisor/projects/loaded-stream-relay-entry.ts",
    entryModule: "loaded-stream-relay-entry.js",
    outputPath: "build/loaded-stream-relay-fixture.json",
  },
];

for (const fixture of FIXTURES) {
  await writeModuleMap(fixture);
}
