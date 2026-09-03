import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defaultExclude, defineConfig } from "vitest/config";

/**
 * Hegel loads a native generator through Koffi, which workerd cannot run. Properties therefore
 * run in Node, but each has a workerd sibling enforced by test/docs/props-siblings.test.ts.
 * tsconfig.json still typechecks both projects against the Worker globals.
 */
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.test.jsonc" } })],
        test: {
          name: "workers",
          include: ["test/**/*.test.ts", "test/**/*.workers.ts", "src/**/*.test.ts"],
          exclude: [...defaultExclude, "**/*.props.test.ts"],
          typecheck: { enabled: false },
        },
      },
      {
        test: {
          name: "node",
          include: ["test/**/*.props.test.ts"],
          environment: "node",
          pool: "forks",
          typecheck: { enabled: false },
        },
      },
    ],
  },
});
