import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defaultExclude, defineConfig } from "vitest/config";

/**
 * Two pools, for two reasons workerd cannot serve.
 *
 * Hegel loads a native generator through Koffi, which workerd cannot run. Properties therefore
 * run in Node, but each has a workerd sibling enforced by test/docs/props-siblings.test.ts.
 * tsconfig.json still typechecks both projects against the Worker globals.
 *
 * workerd also starts no child process, so no test in it can run the repository's own `git`. A
 * `*.node.test.ts` file runs in the same Node project and may spawn a real process: it is how the
 * turn's diff is proved against a real Git repository rather than against a description of one.
 * The workers project excludes both patterns, so each file runs in exactly one pool.
 */
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.test.jsonc" } })],
        test: {
          name: "workers",
          include: ["test/**/*.test.ts", "test/**/*.workers.ts", "src/**/*.test.ts"],
          exclude: [...defaultExclude, "**/*.props.test.ts", "**/*.node.test.ts"],
          typecheck: { enabled: false },
        },
      },
      {
        test: {
          name: "node",
          include: ["test/**/*.props.test.ts", "test/**/*.node.test.ts"],
          environment: "node",
          pool: "forks",
          typecheck: { enabled: false },
        },
      },
    ],
  },
});
