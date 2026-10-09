import { writeModuleMap } from "./module-map-build.mts";

/**
 * Build the Generation 0 main facet into a module map (ADR-0028).
 *
 * The output is the file a harness build writes: an entry module name and the modules, with no
 * commit of its own. The Supervisor gives the map the labeled harness commit it asked to build,
 * so a build cannot claim to be another generation (ADR-0027). `moduleMapFromBuildOutput` in
 * `src/supervisor/artifacts` validates this exact shape.
 *
 * The script reads the working tree, runs esbuild locally, and writes one file. It makes no
 * network request and starts no container, so a Computer build of a checked-out commit runs the
 * same command with the same result.
 */

await writeModuleMap({
  entryPoint: "src/facet/generation-0/main-facet.ts",
  // The module name inside the map, and the entry module the Worker Loader starts.
  entryModule: "main-facet.js",
  // The Supervisor's build plan runs `pnpm run build:module-map` in the extracted commit directory
  // and reads this path, so the name is part of the build contract rather than a local choice.
  outputPath: "build/module-map.json",
});
