import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import {
  assetsConfig,
  cache,
  compatibility,
  durableObjectClasses,
  MODULE_MAPS_BINDING,
  observability,
  plainTextBindings,
  PRODUCTION_STAGE,
  productionRoute,
  STACK_NAME,
  workerEntrypoint,
  workerName,
  shellModulesAssetDirectory,
} from "./worker-settings.js";
import { workspaceImage } from "./workspace-image/image.js";

export default Alchemy.Stack(
  STACK_NAME,
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const { stage } = yield* Stack;
    const isProduction = stage === PRODUCTION_STAGE;
    const name = workerName(stage);
    const moduleMaps = yield* Cloudflare.R2.Bucket("ModuleMaps", { forceDestroy: !isProduction });

    const worker = yield* Cloudflare.Worker("Worker", {
      name,
      main: workerEntrypoint,
      compatibility: {
        date: compatibility.date,
        flags: [...compatibility.flags],
      },
      workersDev: { enabled: true, previewsEnabled: false },
      routes: isProduction
        ? [{ pattern: productionRoute.pattern, zoneName: productionRoute.zone }]
        : [],
      assets: { directory: shellModulesAssetDirectory, config: assetsConfig },
      cache,
      codeUpdateStrategy: { mode: "immediate" },
      observability: observability(isProduction),
      env: {
        ...plainTextBindings(stage),
        SUPERVISOR: Cloudflare.DurableObject(durableObjectClasses.SUPERVISOR),
        WORKSPACE_HOST: Cloudflare.DurableObject(durableObjectClasses.WORKSPACE_HOST, {
          containers: [
            Cloudflare.Container("app", {
              schedulingPolicy: "durable_object",
              image: workspaceImage,
            }),
          ],
        }),
        LOADER: Cloudflare.WorkerLoader(),
        CF_VERSION_METADATA: Cloudflare.Workers.VersionMetadata(),
        AI: Cloudflare.Workers.AI(),
        [MODULE_MAPS_BINDING]: moduleMaps,
      },
    });

    return { name, url: worker.url };
  }),
);
