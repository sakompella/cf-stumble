import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type Cursor,
  type EntryLoader,
  type EntryRecord,
  type TranscriptView,
} from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { answerOf, fetchEffect, field, projectPath, transportDetail } from "./api.js";
import { heldTranscript, type HeldTranscript } from "./view-reader.js";

export { viewReader, type HeldTranscript } from "./view-reader.js";

const held = new Map<number, HeldTranscript>();

function isEntryRecord(value: unknown): value is EntryRecord {
  return (
    Predicate.isObject(value) &&
    "id" in value &&
    typeof value.id === "number" &&
    "conversationId" in value &&
    typeof value.conversationId === "number" &&
    "kind" in value &&
    typeof value.kind === "string"
  );
}

function isCursor(value: unknown): value is Cursor {
  return Predicate.isObject(value) && !Array.isArray(value);
}

function entriesPath(projectId: string, query: Parameters<EntryLoader>[0], limit: number) {
  const params = new URLSearchParams({ order: query.order ?? "descending", limit: String(limit) });

  if (query.minEntryId !== undefined) params.set("min", String(query.minEntryId));

  if (query.maxEntryId !== undefined) params.set("max", String(query.maxEntryId));

  return `${projectPath(projectId, "/entries")}?${params.toString()}`;
}

function loaderFor(projectId: string): EntryLoader {
  return (query, limit) =>
    Effect.runPromise(
      fetchEffect(entriesPath(projectId, query, limit), {
        method: "GET",
        accept: "application/json",
        maybeBody: Option.none(),
      }).pipe(
        Effect.flatMap(answerOf),
        Effect.flatMap(({ payload }) => {
          const items = field(payload, "items");

          const next = field(payload, "next");

          return Array.isArray(items) && items.every(isEntryRecord)
            ? Effect.succeed(isCursor(next) ? { items, next } : { items })
            : Effect.fail("the Worker answered entries the page cannot read");
        }),
      ),
    );
}

export function openTranscript(streamId: number, projectId: string): HeldTranscript {
  const existing = held.get(streamId);

  if (existing !== undefined) return existing;

  const opened = heldTranscript(loaderFor(projectId));

  held.set(streamId, opened);

  return opened;
}

export function closeTranscript(streamId: number): void {
  held.delete(streamId);
}

export function loadIntoTranscript(
  streamId: number,
  itemIndex?: number,
): Effect.Effect<Option.Option<TranscriptView>, string> {
  const current = held.get(streamId);

  if (current === undefined) return Effect.succeed(Option.none());

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
