import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

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

const repoRoot = resolve(import.meta.dirname, "..");
const entryPoint = resolve(repoRoot, "src/facet/generation-0/main-facet.ts");

/** The module name inside the map, and the entry module the Worker Loader starts. */
const ENTRY_MODULE = "main-facet.js";

/**
 * Where the build writes the map, relative to the build directory. The Supervisor's build plan
 * runs `pnpm run build:module-map` in the extracted commit directory and reads this path, so the
 * name is part of the build contract rather than a local choice.
 */
export const MODULE_MAP_PATH = "build/module-map.json";

type BuiltModuleMapFile = {
  readonly entryModule: string;
  readonly modules: readonly { readonly name: string; readonly source: string }[];
};

const bundled = await build({
  entryPoints: [entryPoint],
  outfile: ENTRY_MODULE,
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  target: "es2023",
  conditions: ["workerd", "worker", "browser"],
  // The Worker runtime provides this module; bundling it would break the facet class.
  external: ["cloudflare:workers"],
  legalComments: "none",
  sourcemap: false,
});

const output = bundled.outputFiles.at(0);
if (output === undefined) {
  throw new Error("esbuild produced no output for the Generation 0 entry module");
}

const moduleMap: BuiltModuleMapFile = {
  entryModule: ENTRY_MODULE,
  modules: [{ name: ENTRY_MODULE, source: output.text }],
};

const outputPath = resolve(repoRoot, MODULE_MAP_PATH);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(moduleMap, undefined, 2)}\n`);

console.log(`Wrote ${MODULE_MAP_PATH} (${output.text.length} bytes of module source)`);
