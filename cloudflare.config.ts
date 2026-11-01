import { bindings, defineConfig, defineContainer, exports, triggers } from "cf/config";

const workspaceHostContainer = defineContainer({
  name: "cf-stumble-workspacehost",
  image: {
    dockerfile: "./containers/computerd.Dockerfile",
    buildContext: ".",
  },
  maxInstances: 1,
  instanceType: "standard-3",
});

export default defineConfig(({ mode }) => {
  const isTest = mode === "test";
  const workerName = isTest ? "cf-stumble-test" : "cf-stumble";

  const sharedEnv = {
    SUPERVISOR: bindings.durableObject({ worker: workerName, exportName: "Supervisor" }),
    WORKSPACE_HOST: bindings.durableObject({ worker: workerName, exportName: "WorkspaceHost" }),
    LOADER: bindings.workerLoader(),
    CHATGPT_MODEL: bindings.text("gpt-6.1-sol"),
  };

  return {
    worker: {
      name: workerName,
      entrypoint: "src/worker.ts",
      compatibilityDate: "2025-01-01",
      compatibilityFlags: ["enable_ctx_exports", "nodejs_compat"],
      workersDev: false,
      cache: { enabled: false },
      observability: {
        enabled: true,
        headSamplingRate: 1,
        logs: { enabled: true, headSamplingRate: 1, invocationLogs: true, persist: true },
        traces: { enabled: true, headSamplingRate: 1, persist: true },
        issues: { enabled: true },
      },
      triggers: [triggers.fetch({ pattern: "stumble.akompella.dev/*", zone: "akompella.dev" })],
      exports: {
        Supervisor: exports.durableObject({ storage: "sqlite" }),
        WorkspaceHost: exports.durableObject({
          storage: "sqlite",
          container: workspaceHostContainer,
        }),
      },
      env: isTest ? sharedEnv : { ...sharedEnv, AI: bindings.ai({}) },
    },
    containers: [workspaceHostContainer],
  };
});
