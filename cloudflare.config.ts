import { bindings, defineConfig, defineContainer, exports, triggers } from "cf/config";

// The Wrangler bundler reads build settings from `wrangler.config.ts`. Two Wrangler files remain
// because nothing else reads this one yet: `wrangler.jsonc` for the Deploy to Cloudflare flow and
// `wrangler deploy`, and `wrangler.test.jsonc` for the vitest pool. test/docs/test-config.test.ts
// fails when either drifts from this file.

const WORKER_NAME = "cf-stumble";

// The Dockerfile copies the lockfile and the vendored Computer tarball from the repository root,
// so the build context is the root, not the Dockerfile's directory.
const workspaceHostContainer = defineContainer({
  // Wrangler derived this name as `<worker>-<class>` lowercased. A different name would create a
  // second container application instead of rolling the existing one.
  name: "cf-stumble-workspacehost",
  image: {
    dockerfile: "./containers/computerd.Dockerfile",
    buildContext: ".",
  },
  maxInstances: 1,
  // Check workloads need more CPU, memory, and disk than standard-1 (0.5 vCPU, 4 GiB, 8 GB).
  // standard-3 (2 vCPU, 8 GiB, 16 GB) leaves room for compiler and install peaks.
  instanceType: "standard-3",
});

export default defineConfig({
  worker: {
    name: WORKER_NAME,
    entrypoint: "src/worker.ts",
    compatibilityDate: "2025-01-01",
    // @cloudflare/computer imports node:crypto and node:events, so the Worker does not start
    // without nodejs_compat. Vitest resolves those itself, which is why the suite passed while
    // `wrangler dev` failed to boot.
    compatibilityFlags: ["enable_ctx_exports", "nodejs_compat"],
    // One entry point, and it is the one Cloudflare Access sits in front of. A `workers.dev`
    // subdomain is reachable without Access, so it would leave the Worker's own fail-closed check
    // as the only guard on a second door nobody watches. Turning it off is stated on purpose
    // rather than left to a default.
    workersDev: false,
    // Workers Cache would skip the Worker's Access check, and its key ignores identity.
    cache: { enabled: false },
    // Operator diagnostics go to console.error (src/diagnostics.ts); without logs they vanish.
    observability: { enabled: true },
    // The zone has a proxied wildcard record, so the hostname resolves to another origin unless
    // the Worker claims it. A route rather than a custom domain, because a custom domain writes
    // DNS and a route does not: the wildcard already makes this hostname proxied.
    triggers: [triggers.fetch({ pattern: "stumble.akompella.dev/*", zone: "akompella.dev" })],
    // Both classes are live today and SQLite-backed. This block replaces the Wrangler
    // `migrations` history (v1: Supervisor, v2: WorkspaceHost). Leaving a live class out, or
    // declaring it with another storage engine, can orphan its data on the first deploy from this
    // file. Do not add tombstones: nothing has been renamed or deleted.
    exports: {
      Supervisor: exports.durableObject({ storage: "sqlite" }),
      WorkspaceHost: exports.durableObject({
        storage: "sqlite",
        container: workspaceHostContainer,
      }),
    },
    env: {
      // The harness repository this deployment builds from. A fork sets it to its own repository;
      // empty means the repository named in `src/harness-build.ts`. See `docs/deploy.md`.
      HARNESS_REPOSITORY_URL: bindings.text(""),
      GITHUB_OAUTH_CLIENT_ID: bindings.text(""),
      SUPERVISOR: bindings.durableObject({ worker: WORKER_NAME, exportName: "Supervisor" }),
      WORKSPACE_HOST: bindings.durableObject({ worker: WORKER_NAME, exportName: "WorkspaceHost" }),
      LOADER: bindings.workerLoader(),
      AI: bindings.ai({}),
    },
  },
  containers: [workspaceHostContainer],
});
