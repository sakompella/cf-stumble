import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

/**
 * Builds `test/facet/generation-0/loaded-execution-env-entry.ts` into the same
 * `{ entryModule, modules }` module-map shape `tools/build-generation-0.mts` writes, so
 * `test/facet/generation-0/execution-env-loaded.test.ts` can load it into a real Worker Loader
 * isolate the same way `test/facet/generation-0/module-map.test.ts` loads the built main facet.
 *
 * This is a test-only fixture, not a harness artifact: it carries no labeled commit and is never
 * read by the Supervisor. The output lives under the gitignored `build/` directory alongside
 * `build/module-map.json`.
 */

const repoRoot = resolve(import.meta.dirname, "..");
const entryPoint = resolve(repoRoot, "test/facet/generation-0/loaded-execution-env-entry.ts");

const ENTRY_MODULE = "loaded-execution-env-entry.js";

export const FIXTURE_PATH = "build/loaded-execution-env-fixture.json";

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
  // The Worker runtime provides this module; bundling it would break the entrypoint class.
  external: ["cloudflare:workers"],
  legalComments: "none",
  sourcemap: false,
});

const output = bundled.outputFiles.at(0);
if (output === undefined) {
  throw new Error("esbuild produced no output for the loaded-execution-env-entry fixture");
}

const moduleMap: BuiltModuleMapFile = {
  entryModule: ENTRY_MODULE,
  modules: [{ name: ENTRY_MODULE, source: output.text }],
};

const outputPath = resolve(repoRoot, FIXTURE_PATH);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(moduleMap, undefined, 2)}\n`);

console.log(`Wrote ${FIXTURE_PATH} (${output.text.length} bytes of module source)`);
