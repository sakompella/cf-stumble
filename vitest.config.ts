import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defaultExclude, defineConfig } from "vitest/config";

/**
 * Behavioural coverage runs in workerd, the runtime this project actually deploys to. A test that
 * passes in Node tells you nothing about the runtime you ship to, and the Node half of the old
 * two-config setup had been quietly masking Worker-specific typing bugs, so it was deleted.
 *
 * The `node` project below is a narrow reopening, not a repeal (ADR-0008). Hegel's generation
 * engine is a native Rust library reached through FFI; workerd reports `process.versions.napi` as
 * empty and `process.dlopen` throws "not implemented", so no property test can ever run there.
 * The rule that keeps the original reasoning intact is that Node only adds a generative layer over
 * modules workerd already covers: every `<name>.props.test.ts` must have a `<name>.test.ts` beside
 * it, and `test/docs/props-siblings.test.ts` — which runs in workerd — fails when one does not. A
 * green Node run therefore cannot stand in for workerd coverage of anything.
 *
 * Typechecking is unaffected: one `tsconfig.json` still compiles the whole repo, property tests
 * included, against `@cloudflare/workers-types` only.
 */
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            // The supervisor's privileged routes fail closed without a credential, so the suite
            // has to supply one. It lives here rather than in .dev.vars because .dev.vars is
            // gitignored: tests that depend on an untracked file pass for whoever created it and
            // fail for everyone else. This value is test-only and grants nothing outside
            // miniflare.
            miniflare: { bindings: { SUPERVISOR_SECRET: "test-supervisor-secret" } },
          }),
        ],
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
          // libhegel is loaded through koffi, and a native library that keeps its own engine state
          // has no reason to be safe across the worker threads vitest defaults to. Forks give each
          // test file its own process and its own copy of the library.
          pool: "forks",
          typecheck: { enabled: false },
        },
      },
    ],
  },
});
