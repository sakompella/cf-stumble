import { writeModuleMap } from "./module-map-build.mts";

await writeModuleMap({
  entryPoint: "src/facet/generation-1/main-facet.ts",
  entryModule: "main-facet.js",
  outputPath: "build/module-map.json",
});
