import { bindings, defineConfig, defineContainer, exports, triggers } from "cf/config";
import {
  assetsConfig,
  cache,
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
import { WORKSPACE_CONTAINER_INSTANCE } from "./src/workspace/container-instance.ts";

const workspaceHostContainer = defineContainer({
  name: "cf-stumble-workspacehost",
  image: { reference: workspaceImage },
  maxInstances: 1,
  instanceType: WORKSPACE_CONTAINER_INSTANCE,
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
    ASSETS: bindings.assets(),
    CF_VERSION_METADATA: bindings.versionMetadata(),
  };

  return {
    worker: {
      name,
      entrypoint: workerEntrypoint,
      compatibilityDate: compatibility.date,
      compatibilityFlags: [...compatibility.flags],
      workersDev: false,
      assets: assetsConfig,
      cache,
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
