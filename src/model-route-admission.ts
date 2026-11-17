import * as Effect from "effect/Effect";
import { logRedactedCause } from "./diagnostics.js";
import { GENERATION_REPLACED } from "./generation-replaced.js";
import { modelEventStream, modelUnavailableBecause, type ModelTurn } from "./model-route-turn.js";
import { ROUTE_FAILURE } from "./model-route-wire/failure.js";
import type { ValidationFailure } from "./model-route-wire/request.js";

export function admittedStream(
  admit: () => Promise<boolean>,
  turn: ModelTurn,
): Effect.Effect<ReadableStream<Uint8Array> | ValidationFailure> {
  return Effect.tryPromise({
    try: admit,
    catch: (cause) => {
      logRedactedCause("model-route: supervisor admission failed", cause);

      return modelUnavailableBecause(ROUTE_FAILURE.supervisorUnavailable);
    },
  }).pipe(
    Effect.map((admitted): ReadableStream<Uint8Array> | ValidationFailure =>
      admitted
        ? modelEventStream(turn)
        : { ok: false, error: { code: "invalid-request", reason: GENERATION_REPLACED } },
    ),
    Effect.catch((failed) => Effect.succeed(modelEventStream(() => Effect.fail(failed)))),
  );
}
