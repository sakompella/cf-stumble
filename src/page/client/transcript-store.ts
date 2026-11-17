import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ManagedResource } from "foldkit";
import { transportDetail } from "./api.js";
import { loaderFor } from "./entries-loader.js";
import { Message } from "./message.js";
import type { Model } from "./model.js";
import {
  heldTranscript,
  TranscriptKey,
  type HeldTranscript,
} from "../../conversation-view/view-reader.js";

type LoadedView = NonNullable<HeldTranscript["latest"]>;

export const MaybeTranscriptKey = Schema.Option(TranscriptKey);

function requestedTranscript(model: Model): Option.Option<TranscriptKey> {
  return Option.map(model.maybeProjectId, (projectId) => ({
    streamId: model.eventsStreamId,
    projectId,
  }));
}

export function streamableTranscript(model: Model): Option.Option<TranscriptKey> {
  return Option.filter(model.maybeHeldTranscript, (held) =>
    Option.match(requestedTranscript(model), {
      onNone: () => false,
      onSome: (requested) =>
        held.streamId === requested.streamId && held.projectId === requested.projectId,
    }),
  );
}

export const TranscriptResource = ManagedResource.tag<HeldTranscript>()("Transcript");

export type TranscriptService = ManagedResource.ServiceOf<typeof TranscriptResource>;

export const managedResources = ManagedResource.make<Model, Message>()((entry) => ({
  transcript: entry(MaybeTranscriptKey, {
    resource: TranscriptResource,
    modelToMaybeRequirements: requestedTranscript,
    acquire: (key) => Effect.sync(() => heldTranscript(key, loaderFor(key.projectId))),
    release: () => Effect.void,
    onAcquired: ({ key }) => Message.AcquiredTranscript(key),
    onReleased: () => Message.ReleasedTranscript(),
    onAcquireError: () => Message.ReleasedTranscript(),
  }),
}));

function loadInto(
  current: HeldTranscript,
  itemIndex: number | undefined,
): Effect.Effect<Option.Option<LoadedView>, string> {
  const gap = itemIndex === undefined ? undefined : current.latest?.items[itemIndex];

  const { transcript } = current;

  return Effect.tryPromise({
    try: () =>
      gap?.kind === "gap"
        ? transcript.fillGap(gap, BACKGROUND_CONTEXT)
        : transcript.loadEarlier(BACKGROUND_CONTEXT),
    catch: transportDetail,
  }).pipe(
    Effect.map((loaded) => {
      if (current.transcript !== transcript) return Option.none();

      current.latest = loaded;

      return Option.some(loaded);
    }),
  );
}

export function loadIntoTranscript(
  itemIndex?: number,
): Effect.Effect<Option.Option<LoadedView>, string, TranscriptService> {
  return TranscriptResource.get.pipe(
    Effect.flatMap((current) => loadInto(current, itemIndex)),
    Effect.catchTag("ResourceNotAvailable", () => Effect.succeedNone),
  );
}
