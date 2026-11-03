import type { EntryId, EntryQuery } from "@earendil-works/pi-durable";
import type { EntriesRequest } from "../entries-request.js";

function isEntryId(value: number): value is EntryId {
  return Number.isSafeInteger(value) && value >= 0;
}

export function entryId(value: number | undefined): EntryId | undefined {
  return value !== undefined && isEntryId(value) ? value : undefined;
}

export function entriesQuery({
  order,
  minEntryId,
  maxEntryId,
}: EntriesRequest): Omit<EntryQuery, "conversationId"> {
  const min = entryId(minEntryId);
  const max = entryId(maxEntryId);

  if (min !== undefined && max !== undefined) return { order, minEntryId: min, maxEntryId: max };

  if (min !== undefined) return { order, minEntryId: min };

  return max === undefined ? { order } : { order, maxEntryId: max };
}
