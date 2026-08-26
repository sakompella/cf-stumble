import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // The supervisor's privileged routes fail closed without a credential, so the suite has
      // to supply one. It lives here rather than in .dev.vars because .dev.vars is gitignored:
      // tests that depend on an untracked file pass for whoever created it and fail for
      // everyone else. This value is test-only and grants nothing outside miniflare.
      miniflare: { bindings: { SUPERVISOR_SECRET: "test-supervisor-secret" } },
    }),
  ],
  test: {
    include: [
      "test/facet/**/*.test.ts",
      "test/storage-do/**/*.test.ts",
      "test/supervisor/**/*.workers.ts",
    ],
    typecheck: { enabled: false },
  },
});
