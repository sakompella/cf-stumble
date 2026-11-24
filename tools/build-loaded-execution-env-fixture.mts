import { writeModuleMap } from "./module-map-build.mts";

await writeModuleMap({
  entryPoint: "test/supervisor/projects/loaded-stream-relay-entry.ts",
  entryModule: "loaded-stream-relay-entry.js",
  outputPath: "build/loaded-stream-relay-fixture.json",
});
