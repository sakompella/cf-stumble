import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
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
} from "./worker-settings.js";

export default Alchemy.Stack(
  "cf-stumble",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const { stage } = yield* Stack;
    const isProduction = stage === PRODUCTION_STAGE;
    const name = workerName(stage);

    const worker = yield* Cloudflare.Worker("Worker", {
      name,
      main: workerEntrypoint,
      compatibility: {
        date: compatibility.date,
        flags: [...compatibility.flags, "legacy_module_registry"],
      },
      workersDev: isProduction ? false : { enabled: true, previewsEnabled: false },
      routes: isProduction
        ? [{ pattern: productionRoute.pattern, zoneName: productionRoute.zone }]
        : [],
      cache: { enabled: false },
      observability: observability(isProduction),
      env: {
        ...plainTextBindings,
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
        AI: Cloudflare.Workers.AI(),
      },
    });

    return { name, url: worker.url };
  }),
);
