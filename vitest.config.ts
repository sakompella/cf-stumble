import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * One runtime: everything runs inside workerd, the runtime this project actually deploys to.
 *
 * There used to be a second Node-side config. It existed because the git codec's independent
 * oracle shelled out to the `git` binary and some fixtures were read with `node:fs`, neither of
 * which works in workerd. Both are gone — isomorphic-git is the oracle now and fixtures are
 * imported as JSON — so the split had no reason to survive. A test that passes in Node tells
 * you nothing about the runtime you ship to.
 */
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
    include: ["test/**/*.test.ts", "test/**/*.workers.ts", "src/**/*.test.ts"],
    typecheck: { enabled: false },
  },
});
