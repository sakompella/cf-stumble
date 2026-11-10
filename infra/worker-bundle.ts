import * as Cloudflare from "@alchemy.run/cloudflare";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Artifacts, createArtifactStore, makeScopedArtifacts } from "alchemy/Artifacts";
import * as Effect from "effect/Effect";
import {
  compatibility,
  PRODUCTION_STAGE,
  STACK_NAME,
  workerEntrypoint,
  workerName,
} from "./worker-settings.js";

const WORKER_ID = "Worker";

const props = {
  main: workerEntrypoint,
  compatibility: { date: compatibility.date, flags: [...compatibility.flags] },
  isExternal: true,
};

export function buildWorkerBundle() {
  return Effect.runPromise(
    Effect.gen(function* () {
      const source = yield* Cloudflare.Workers.resolveSource(props);

      const { bundle } = yield* source.build(
        Cloudflare.Workers.makeSourceContext({
          id: WORKER_ID,
          fqn: WORKER_ID,
          workerName: workerName(PRODUCTION_STAGE),
          props,
          compatibility: props.compatibility,
          stack: { name: STACK_NAME, stage: PRODUCTION_STAGE },
        }),
      );

      if (bundle === undefined)
        return yield* Effect.die(new Error("Alchemy built no Worker bundle"));

      return bundle.files;
    }).pipe(
      Effect.scoped,
      Effect.provideService(Artifacts, makeScopedArtifacts(createArtifactStore(), WORKER_ID)),
      Effect.provide(NodeServices.layer),
    ),
  );
}
