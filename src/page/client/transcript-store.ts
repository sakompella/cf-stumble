import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ManagedResource } from "foldkit";
import { transportDetail } from "./api.js";
import { loaderFor } from "./entries-loader.js";
import { Message } from "./message.js";
import type { Model } from "./model.js";
import { heldTranscript, type HeldTranscript } from "./view-reader.js";

type LoadedView = NonNullable<HeldTranscript["latest"]>;

export const MaybeTranscriptKey = Schema.Option(
  Schema.Struct({ streamId: Schema.Number, projectId: Schema.String }),
);

export const TranscriptResource = ManagedResource.tag<HeldTranscript>()("Transcript");

export type TranscriptService = ManagedResource.ServiceOf<typeof TranscriptResource>;

export const managedResources = ManagedResource.make<Model, Message>()((entry) => ({
  transcript: entry(MaybeTranscriptKey, {
    resource: TranscriptResource,
    modelToMaybeRequirements: (model) =>
      Option.map(model.maybeProjectId, (projectId) => ({
        streamId: model.eventsStreamId,
        projectId,
      })),
    acquire: ({ projectId }) => Effect.sync(() => heldTranscript(loaderFor(projectId))),
    release: () => Effect.void,
    onAcquired: () => Message.SettledTranscript(),
    onReleased: () => Message.SettledTranscript(),
    onAcquireError: () => Message.SettledTranscript(),
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
    Effect.catchTag("ResourceNotAvailable", () => Effect.succeed(Option.none())),
  );
}
