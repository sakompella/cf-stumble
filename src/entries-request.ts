export type EntriesRequest = Readonly<{
  minEntryId: number | undefined;
  maxEntryId: number | undefined;
  order: "ascending" | "descending";
  limit: number;
}>;

const DEFAULT_LIMIT = 50;

const MAX_LIMIT = 100;

function count(params: URLSearchParams, key: string): number | null | undefined {
  const value = params.get(key);

  if (value === null) return undefined;

  return /^\d{1,15}$/u.test(value) ? Number(value) : null;
}

export function eventsFrom(params: URLSearchParams): number | null | undefined {
  return count(params, "from");
}

export function parseEntriesRequest(params: URLSearchParams): EntriesRequest | undefined {
  const min = count(params, "min");
  const max = count(params, "max");
  const limit = count(params, "limit") ?? DEFAULT_LIMIT;
  const order = params.get("order") ?? "descending";

  if (
    min === null ||
    max === null ||
    limit === null ||
    limit < 1 ||
    limit > MAX_LIMIT ||
    (order !== "ascending" && order !== "descending")
  ) {
    return undefined;
  }

  return { order, limit, minEntryId: min, maxEntryId: max };
}

export function encodeEntriesRequest(request: EntriesRequest): URLSearchParams {
  const params = new URLSearchParams({ order: request.order, limit: String(request.limit) });

  if (request.minEntryId !== undefined) params.set("min", String(request.minEntryId));

  if (request.maxEntryId !== undefined) params.set("max", String(request.maxEntryId));

  return params;
}
