import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": resolve(import.meta.dirname, "test/node/cloudflare-workers.ts"),
    },
  },
  test: {
    environment: "node",
    pool: "forks",
    testTimeout: 60_000,
    restoreMocks: true,
    unstubGlobals: true,
    server: { deps: { inline: ["@cloudflare/computer"] } },
    include: ["test/**/*.props.test.ts", "test/**/*.shell.test.ts"],
    exclude: ["test/page/client/**"],
  },
});
