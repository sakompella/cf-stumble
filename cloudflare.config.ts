import { bindings, defineConfig, defineContainer, exports, triggers } from "cf/config";
import {
  compatibility,
  durableObjectClasses,
  observability,
  plainTextBindings,
  PRODUCTION_STAGE,
  productionRoute,
  workerEntrypoint,
  workerName,
  workspaceImage,
} from "./infra/worker-settings.ts";

const workspaceHostContainer = defineContainer({
  name: "cf-stumble-workspacehost",
  image: { reference: workspaceImage },
  maxInstances: 1,
  instanceType: "standard-3",
});

export default defineConfig(({ mode }) => {
  const isTest = mode === "test";
  const name = workerName(isTest ? "test" : PRODUCTION_STAGE);

  const sharedEnv = {
    ...Object.fromEntries(
      Object.entries(plainTextBindings).map(([key, value]) => [key, bindings.text(value)]),
    ),
    SUPERVISOR: bindings.durableObject({
      worker: name,
      exportName: durableObjectClasses.SUPERVISOR,
    }),
    WORKSPACE_HOST: bindings.durableObject({
      worker: name,
      exportName: durableObjectClasses.WORKSPACE_HOST,
    }),
    LOADER: bindings.workerLoader(),
  };

  return {
    worker: {
      name,
      entrypoint: workerEntrypoint,
      compatibilityDate: compatibility.date,
      compatibilityFlags: [...compatibility.flags],
      workersDev: false,
      cache: { enabled: false },
      observability: observability(true),
      triggers: [triggers.fetch(productionRoute)],
      exports: {
        [durableObjectClasses.SUPERVISOR]: exports.durableObject({ storage: "sqlite" }),
        [durableObjectClasses.WORKSPACE_HOST]: exports.durableObject(
          isTest ? { storage: "sqlite" } : { storage: "sqlite", container: workspaceHostContainer },
        ),
      },
      env: isTest ? sharedEnv : { ...sharedEnv, AI: bindings.ai({}) },
    },
    containers: isTest ? [] : [workspaceHostContainer],
  };
});
