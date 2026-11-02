import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { build } from "esbuild";
import { defaultExclude, defineConfig, type Plugin } from "vitest/config";
import {
  compatibility,
  durableObjectClasses,
  plainTextBindings,
  workerName,
} from "./infra/worker-settings.js";

const EFFECT_PATH = /^effect(?:\/[\w-]+)*$/u;

const EFFECT_IMPORT = /from\s+"(effect(?:\/[\w-]+)*)"/gu;

const PREBUNDLE_DIRECTORY = resolve(import.meta.dirname, "node_modules/.cache/effect-prebundle");

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

const PLATFORM_STREAM_REJECTIONS = [
  {
    file: "test/supervisor/conversations/generation-1.test.ts",
    message: "ReadableStream received over RPC disconnected prematurely.",
  },
  { file: "test/supervisor/projects/turn-cancel.test.ts", message: "Stream was cancelled." },
  { file: "test/supervisor/startup-check/body.test.ts", message: "body exploded" },
  { file: "test/supervisor/startup-check/body.test.ts", message: "startup-check deadline expired" },
] as const;

function isPlatformStreamNoise(error: { message?: string; VITEST_TEST_PATH?: string }): boolean {
  return PLATFORM_STREAM_REJECTIONS.some(
    ({ file, message }) =>
      error.message === message && error.VITEST_TEST_PATH?.endsWith(file) === true,
  );
}

export default defineConfig({
  test: {
    silent: "passed-only",
    onUnhandledError: (error) => !isPlatformStreamNoise(error),
    projects: [
      {
        plugins: [
          await effectPrebundle(),
          cloudflareTest({
            main: "./src/worker.ts",
            miniflare: {
              name: workerName("test"),
              compatibilityDate: compatibility.date,
              compatibilityFlags: compatibility.flags,
              bindings: plainTextBindings,
              durableObjects: Object.fromEntries(
                Object.entries(durableObjectClasses).map(([binding, className]) => [
                  binding,
                  { className, useSQLite: true },
                ]),
              ),
              workerLoaders: { LOADER: {} },
            },
          }),
        ],
        test: {
          name: "workers",
          testTimeout: 20_000,
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
        resolve: {
          alias: {
            "cloudflare:workers": resolve(import.meta.dirname, "test/node/cloudflare-workers.ts"),
          },
        },
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
