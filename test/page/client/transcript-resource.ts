import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import {
  managedResources,
  TranscriptResource,
  type TranscriptService,
} from "../../../src/page/client/transcript-store.js";

export function openedTranscript(projectId = "repo") {
  const held = Effect.runSync(
    Effect.scoped(managedResources.transcript.acquire({ streamId: 1, projectId })),
  );

  const ref = Ref.makeUnsafe(Option.some(held));

  return {
    held,
    provide: <A, E>(effect: Effect.Effect<A, E, TranscriptService>): Effect.Effect<A, E> =>
      Effect.provideService(effect, TranscriptResource._tag, ref),
  };
}
