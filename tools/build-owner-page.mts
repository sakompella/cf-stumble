import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build, type BuildOptions, type Plugin } from "esbuild";
import { workerAssetDirectory } from "../infra/worker-settings.ts";

const repoRoot = resolve(import.meta.dirname, "..");

const HASH_LENGTH = 16;

const UNUSED_PIERRE_LOADERS =
  /^(?:shiki(?:\/.*)?|@shikijs\/.*|@pierre\/theming\/themes|@pierre\/highlights\/themes\/loader)$/u;

const WORDS_WITH_MATH = /^@pierre\/words$/u;

const ANY_PATH = /.*/u;

function esbuildFilter(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.replace("u", ""));
}

const pierreModules: Plugin = {
  name: "pierre-modules",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: esbuildFilter(UNUSED_PIERRE_LOADERS) }, ({ path }) => ({
      path,
      namespace: "unused-pierre-loader",
    }));
    pluginBuild.onLoad(
      { filter: esbuildFilter(ANY_PATH), namespace: "unused-pierre-loader" },
      () => ({
        contents: "module.exports = {};",
        loader: "js",
      }),
    );
    pluginBuild.onResolve({ filter: esbuildFilter(WORDS_WITH_MATH) }, ({ resolveDir, kind }) =>
      pluginBuild.resolve("@pierre/words/no-math", { resolveDir, kind }),
    );
  },
};

const shared: BuildOptions = {
  bundle: true,
  write: false,
  platform: "browser",
  target: "es2023",
  minify: true,
  legalComments: "none",
  sourcemap: false,
};

async function bundle(entryPath: string, options: BuildOptions): Promise<string> {
  const bundled = await build({
    ...shared,
    ...options,
    entryPoints: [resolve(repoRoot, entryPath)],
  });

  const output = bundled.outputFiles?.at(0);

  if (output === undefined) {
    throw new Error(`esbuild produced no output for ${entryPath}`);
  }

  return output.text;
}

function scriptPath(name: string, script: string): string {
  const hash = createHash("sha256").update(script).digest("hex").slice(0, HASH_LENGTH);

  return `/assets/${name}-${hash}.js`;
}

async function writePathModule(outputPath: string, exports: Readonly<Record<string, string>>) {
  const lines = Object.entries(exports).map(
    ([name, value]) => `export const ${name} = ${JSON.stringify(value)};\n`,
  );

  await writeFile(resolve(repoRoot, outputPath), lines.join(""));
}

const pierre = await bundle("src/page/client/pierre/entry.ts", {
  format: "esm",
  loader: { ".css": "text" },
  plugins: [pierreModules],
});

const pierrePath = scriptPath("pierre", pierre);

const pageAssets = resolve(repoRoot, workerAssetDirectory, "assets");

await rm(pageAssets, { recursive: true, force: true });

await mkdir(pageAssets, { recursive: true });

await writeFile(resolve(repoRoot, workerAssetDirectory, `.${pierrePath}`), pierre);

await writePathModule("src/page/pierre-script.generated.ts", { PIERRE_SCRIPT_PATH: pierrePath });

console.log(`Wrote ${workerAssetDirectory}${pierrePath}: ${pierre.length} bytes`);

const owner = await bundle("src/page/client/entry.ts", {
  format: "iife",
  define: { "import.meta.hot": "undefined" },
});

const ownerPath = scriptPath("owner", owner);

await writePathModule("src/page/owner-script.generated.ts", {
  OWNER_SCRIPT_PATH: ownerPath,
  OWNER_SCRIPT_SOURCE: owner,
});

console.log(`Wrote src/page/owner-script.generated.ts: ${ownerPath}, ${owner.length} bytes`);
