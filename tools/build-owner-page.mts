import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build, type BuildOptions, type Plugin } from "esbuild";

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

async function writeScriptModule(outputPath: string, name: string, script: string): Promise<void> {
  const hash = createHash("sha256").update(script).digest("hex").slice(0, HASH_LENGTH);
  const scriptPath = `/assets/${name.toLowerCase()}-${hash}.js`;

  await writeFile(
    resolve(repoRoot, outputPath),
    `export const ${name}_SCRIPT_PATH = ${JSON.stringify(scriptPath)};\n` +
      `export const ${name}_SCRIPT_SOURCE = ${JSON.stringify(script)};\n`,
  );
  console.log(`Wrote ${outputPath}: ${scriptPath}, ${script.length} bytes`);
}

const pierre = await bundle("src/page/client/pierre/entry.ts", {
  format: "esm",
  loader: { ".css": "text" },
  plugins: [pierreModules],
});

await writeScriptModule("src/page/pierre-script.generated.ts", "PIERRE", pierre);

const owner = await bundle("src/page/client/entry.ts", {
  format: "iife",
  define: { "import.meta.hot": "undefined" },
});

await writeScriptModule("src/page/owner-script.generated.ts", "OWNER", owner);
