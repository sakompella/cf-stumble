import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defaultExclude, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
        test: {
          name: "workers",
          include: ["test/**/*.test.ts", "test/**/*.workers.ts", "src/**/*.test.ts"],
          exclude: defaultExclude,
          typecheck: { enabled: false },
        },
      },
    ],
  },
});
