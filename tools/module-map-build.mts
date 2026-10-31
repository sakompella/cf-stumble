import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

export type ModuleMapBuild = {
  readonly entryPoint: string;
  readonly entryModule: string;
  readonly outputPath: string;
};

type BuiltModuleMapFile = {
  readonly entryModule: string;
  readonly modules: readonly { readonly name: string; readonly source: string }[];
};

const repoRoot = resolve(import.meta.dirname, "..");

export async function writeModuleMap(target: ModuleMapBuild): Promise<void> {
  const bundled = await build({
    entryPoints: [resolve(repoRoot, target.entryPoint)],
    outfile: target.entryModule,
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2023",
    conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:workers"],
    legalComments: "none",
    sourcemap: false,
  });

  const output = bundled.outputFiles.at(0);

  if (output === undefined) {
    throw new Error(`esbuild produced no output for ${target.entryPoint}`);
  }

  const moduleMap: BuiltModuleMapFile = {
    entryModule: target.entryModule,
    modules: [{ name: target.entryModule, source: output.text }],
  };

  const outputPath = resolve(repoRoot, target.outputPath);

  await mkdir(dirname(outputPath), { recursive: true });

  await writeFile(outputPath, `${JSON.stringify(moduleMap, undefined, 2)}\n`);

  console.log(`Wrote ${target.outputPath} (${output.text.length} bytes of module source)`);
}
