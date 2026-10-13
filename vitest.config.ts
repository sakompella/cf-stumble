import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { build } from "esbuild";
import { defaultExclude, defineConfig, type Plugin } from "vitest/config";

/**
 * The workers pool evaluates every module again in each test file's isolate, and `effect` ships
 * its code as hundreds of small modules. Loading them one by one cost each isolate about 360 ms
 * for `effect/Effect` and 1.3 s for the `effect` index, which made the whole suite up to 80 percent
 * slower. So the workers project loads Effect from one minified esbuild bundle per module path
 * that `src` or `test` imports, built when Vitest starts. The Worker that ships is also an esbuild
 * bundle, so tests still run the same code.
 *
 * A path that nothing in `src` or `test` names cannot be served from the bundle, and this plugin
 * fails the import instead of loading a second copy of Effect from `node_modules`.
 */
const EFFECT_PATH = /^effect(?:\/[\w-]+)*$/u;

const EFFECT_IMPORT = /from\s+"(effect(?:\/[\w-]+)*)"/gu;

const PREBUNDLE_DIRECTORY = resolve(import.meta.dirname, "node_modules/.cache/effect-prebundle");

/** The owner page's browser program and its tests run in Node, not in the workers pool. */
const OWNER_PAGE_CLIENT = ["src/page/client/**", "test/page/client/**"];

function importedEffectPaths(): readonly string[] {
  const sources = globSync(["src/**/*.ts", "test/**/*.ts"], {
    cwd: import.meta.dirname,
    exclude: OWNER_PAGE_CLIENT,
  });

  const paths = sources.flatMap((source) =>
    [...readFileSync(resolve(import.meta.dirname, source), "utf8").matchAll(EFFECT_IMPORT)].map(
      (found) => found[1] ?? "",
    ),
  );

  return [...new Set(paths)].toSorted();
}

function bundleName(path: string): string {
  return path.replaceAll("/", "__");
}

async function effectPrebundle(): Promise<Plugin> {
  const paths = importedEffectPaths();

  await build({
    entryPoints: paths.map((path) => ({ in: path, out: bundleName(path) })),
    absWorkingDir: import.meta.dirname,
    outdir: PREBUNDLE_DIRECTORY,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "neutral",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["module", "main"],
    target: "es2022",
    minify: true,
    keepNames: true,
    legalComments: "none",
    logLevel: "error",
  });

  return {
    name: "effect-prebundle",
    enforce: "pre",
    resolveId(id) {
      if (!EFFECT_PATH.test(id)) return null;

      if (!paths.includes(id)) {
        throw new Error(`${id} is not prebundled: no file in src or test imports it`);
      }

      return resolve(PREBUNDLE_DIRECTORY, `${bundleName(id)}.mjs`);
    },
  };
}

/**
 * Hegel loads a native generator through Koffi, which workerd cannot run. Properties therefore
 * run in Node, but each has a workerd sibling enforced by test/docs/props-siblings.test.ts.
 * Shell tests also run in Node, because workerd has no `node:child_process` to start `/bin/sh`.
 * tsconfig.json still typechecks both projects against the Worker globals.
 *
 * The owner page's Foldkit program runs in a browser, so its tests run in Node too, and its own
 * tsconfig files typecheck it against the DOM. Foldkit imports the `effect` index, which the
 * prebundle above deliberately refuses.
 */
/**
 * workerd rejects a promise of its own, which no code can reach or handle, when a reader cancels a
 * stream received over Workers RPC while a read is pending; the pending read itself rejects and
 * is handled. A turn that ends while its generation is quiet does exactly that, and only
 * `turn-cancel.test.ts` runs a real generation that far, so the error is ignored there alone.
 */
function isRpcStreamCancelNoise(error: { message?: string; VITEST_TEST_PATH?: string }): boolean {
  return (
    error.message === "Stream was cancelled." &&
    error.VITEST_TEST_PATH?.endsWith("test/supervisor/projects/turn-cancel.test.ts") === true
  );
}

export default defineConfig({
  test: {
    silent: "passed-only",
    onUnhandledError: (error) => !isRpcStreamCancelNoise(error),
    projects: [
      {
        plugins: [
          await effectPrebundle(),
          cloudflareTest({ wrangler: { configPath: "./wrangler.test.jsonc" } }),
        ],
        test: {
          name: "workers",
          include: ["test/**/*.test.ts"],
          exclude: [
            ...defaultExclude,
            "**/*.props.test.ts",
            "**/*.shell.test.ts",
            ...OWNER_PAGE_CLIENT,
          ],
        },
      },
      {
        test: {
          name: "node",
          include: [
            "test/**/*.props.test.ts",
            "test/**/*.shell.test.ts",
            "test/page/client/**/*.test.ts",
          ],
          environment: "node",
          pool: "forks",
        },
      },
    ],
  },
});
