import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { loaderFor } from "../../../src/page/client/entries-loader.js";
import {
  TranscriptResource,
  type TranscriptService,
} from "../../../src/page/client/transcript-store.js";
import { heldTranscript } from "../../../src/page/client/view-reader.js";

export function openedTranscript(projectId = "repo") {
  const held = heldTranscript({ streamId: 1, projectId }, loaderFor(projectId));

  const ref = Ref.makeUnsafe(Option.some(held));

  return {
    held,
    provide: <A, E>(effect: Effect.Effect<A, E, TranscriptService>): Effect.Effect<A, E> =>
      Effect.provideService(effect, TranscriptResource._tag, ref),
  };
}
