import { type Cursor, type EntryLoader, type EntryRecord } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { answerOf, fetchEffect, field, projectPath } from "./api.js";

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
          const items = field(payload, "items");

          const next = field(payload, "next");

          return Array.isArray(items) && items.every(isEntryRecord)
            ? Effect.succeed(isCursor(next) ? { items, next } : { items })
            : Effect.fail("the Worker answered entries the page cannot read");
        }),
      ),
    );
}
