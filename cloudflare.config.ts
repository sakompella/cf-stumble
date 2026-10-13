import { bindings, defineConfig, defineContainer, exports, triggers } from "cf/config";

// The Wrangler bundler reads build settings from `wrangler.config.ts`. Two Wrangler files remain
// because nothing else reads this one yet: `wrangler.jsonc` for the Deploy to Cloudflare flow and
// `wrangler deploy`, and `wrangler.test.jsonc` for the vitest pool.
// test/docs/cloudflare-config-drift.test.ts fails when either drifts from this file.

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
    // Every rate is 1: the start and end events of one request must both survive, and a sampled
    // trace would drop the requests an operator needs. Traces bill one event per span against the
    // same quota as logs (20M a month on Workers Paid, then $0.60 per million), so lower
    // `traces.headSamplingRate` first if the bill grows. Issues must stay enabled here: a
    // deployment from a configuration without it turns Issues off.
    observability: {
      enabled: true,
      headSamplingRate: 1,
      logs: { enabled: true, headSamplingRate: 1, invocationLogs: true, persist: true },
      traces: { enabled: true, headSamplingRate: 1, persist: true },
      issues: { enabled: true },
    },
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
      // Instance values (`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `CF_ACCESS_OWNER_SUB`,
      // `HARNESS_REPOSITORY_URL`, `GITHUB_OAUTH_CLIENT_ID`, `GH_TOKEN`) are Worker secrets that each
      // instance sets itself, and they are deliberately not declared here. `cf deploy` keeps
      // undeclared secrets but removes undeclared plain-text variables. Declaring a secret makes it
      // required, which stops the first deploy of a new Worker: `CF_ACCESS_OWNER_SUB` only exists
      // after you sign in to the deployed hostname. The Worker fails closed until they are set.
      // See `docs/deploy.md`.
      SUPERVISOR: bindings.durableObject({ worker: WORKER_NAME, exportName: "Supervisor" }),
      WORKSPACE_HOST: bindings.durableObject({ worker: WORKER_NAME, exportName: "WorkspaceHost" }),
      LOADER: bindings.workerLoader(),
      // Workers AI answers turns while no ChatGPT credential is connected (ADR-0047).
      AI: bindings.ai({}),
      // The model ChatGPT turns use. Plain configuration, declared so `cf deploy` keeps it. The
      // default is the one OpenAI's "Sign in with ChatGPT" docs use, and the coding model of the
      // GPT-6 family; the connected account must have it (GET https://api.openai.com/v1/models).
      CHATGPT_MODEL: bindings.text("gpt-6.1-sol"),
    },
  },
  containers: [workspaceHostContainer],
});
