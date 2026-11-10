import { type Cursor, type EntryLoader, type EntryRecord } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { encodeEntriesRequest } from "../../entries-request.js";
import { answerOf, fetchEffect, projectPath } from "./api.js";

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

const EntriesPage = Schema.Struct({
  items: Schema.Array(Schema.declare(isEntryRecord)),
  next: Schema.optional(Schema.declare(isCursor)),
});

const decodeEntriesPage = Schema.decodeUnknownOption(EntriesPage);

function entriesPath(projectId: string, query: Parameters<EntryLoader>[0], limit: number) {
  const params = encodeEntriesRequest({
    order: query.order ?? "descending",
    limit,
    minEntryId: query.minEntryId,
    maxEntryId: query.maxEntryId,
  });

  return `${projectPath(projectId, "/entries")}?${params.toString()}`;
}

export function loaderFor(projectId: string): EntryLoader {
  return (query, limit) =>
    Effect.runPromise(
      fetchEffect(entriesPath(projectId, query, limit), {
        method: "GET",
        accept: "application/json",
        maybeBody: Option.none(),
      }).pipe(
        Effect.flatMap(answerOf),
        Effect.flatMap(({ payload }) => {
          const page = Option.getOrUndefined(decodeEntriesPage(payload));

          if (page === undefined) {
            return Effect.fail("the Worker answered entries the page cannot read");
          }

          const { items, next } = page;

          return Effect.succeed(next === undefined ? { items } : { items, next });
        }),
      ),
    );
}
