import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

/**
 * Builds each test-only Worker Loader entrypoint into the same `{ entryModule, modules }`
 * module-map shape `tools/build-generation-0.mts` writes, so the loaded-isolate tests can load
 * them the same way `test/facet/generation-0/module-map.test.ts` loads the built main facet.
 *
 * These are test fixtures, not harness artifacts: they carry no labeled commit and are never read
 * by the Supervisor. The output lives under the gitignored `build/` directory alongside
 * `build/module-map.json`.
 */

const repoRoot = resolve(import.meta.dirname, "..");

type Fixture = {
  readonly entryPoint: string;
  readonly entryModule: string;
  readonly outputPath: string;
};

const FIXTURES: readonly Fixture[] = [
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

type BuiltModuleMapFile = {
  readonly entryModule: string;
  readonly modules: readonly { readonly name: string; readonly source: string }[];
};

async function buildFixture(fixture: Fixture): Promise<void> {
  const bundled = await build({
    entryPoints: [resolve(repoRoot, fixture.entryPoint)],
    outfile: fixture.entryModule,
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
    throw new Error(`esbuild produced no output for ${fixture.entryPoint}`);
  }

  const moduleMap: BuiltModuleMapFile = {
    entryModule: fixture.entryModule,
    modules: [{ name: fixture.entryModule, source: output.text }],
  };

  const outputPath = resolve(repoRoot, fixture.outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(moduleMap, undefined, 2)}\n`);

  console.log(`Wrote ${fixture.outputPath} (${output.text.length} bytes of module source)`);
}

for (const fixture of FIXTURES) {
  await buildFixture(fixture);
}
