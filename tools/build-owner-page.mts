import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const repoRoot = resolve(import.meta.dirname, "..");

const ENTRY_PATH = "src/page/client/entry.ts";

const OUTPUT_PATH = "src/page/owner-script.generated.ts";

const HASH_LENGTH = 16;

const bundled = await build({
  entryPoints: [resolve(repoRoot, ENTRY_PATH)],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2023",
  minify: true,
  define: { "import.meta.hot": "undefined" },
  legalComments: "none",
  sourcemap: false,
});

const output = bundled.outputFiles.at(0);

if (output === undefined) {
  throw new Error(`esbuild produced no output for ${ENTRY_PATH}`);
}

const script = output.text;

const hash = createHash("sha256").update(script).digest("hex").slice(0, HASH_LENGTH);

const scriptPath = `/assets/owner-${hash}.js`;

await writeFile(
  resolve(repoRoot, OUTPUT_PATH),
  `export const OWNER_PAGE_SCRIPT_PATH = ${JSON.stringify(scriptPath)};\n` +
    `export const OWNER_PAGE_SCRIPT_SOURCE = ${JSON.stringify(script)};\n`,
);

console.log(`Wrote ${OUTPUT_PATH}: ${scriptPath}, ${script.length} bytes`);
