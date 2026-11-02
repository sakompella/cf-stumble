import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import {
  compatibility,
  durableObjectClasses,
  plainTextBindings,
  PRODUCTION_STAGE,
  workerName,
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
      main: "src/worker.ts",
      compatibility: {
        date: compatibility.date,
        flags: [...compatibility.flags, "legacy_module_registry"],
      },
      workersDev: isProduction ? false : { enabled: true, previewsEnabled: false },
      routes: isProduction
        ? [{ pattern: "stumble.akompella.dev/*", zoneName: "akompella.dev" }]
        : [],
      cache: { enabled: false },
      observability: {
        enabled: true,
        headSamplingRate: 1,
        logs: { enabled: true, headSamplingRate: 1, invocationLogs: true, persist: true },
        traces: { enabled: isProduction, headSamplingRate: 1, persist: true },
        issues: { enabled: true },
      },
      env: {
        ...plainTextBindings,
        SUPERVISOR: Cloudflare.DurableObject(durableObjectClasses.SUPERVISOR),
        WORKSPACE_HOST: Cloudflare.DurableObject(durableObjectClasses.WORKSPACE_HOST, {
          containers: [
            Cloudflare.Container("app", {
              schedulingPolicy: "durable_object",
              dockerfile: "containers/computerd.Dockerfile",
              context: ".",
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
