export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;

export type JsonObject = {
  readonly [key: string]: JsonValue;
};

type PendingJsonValue = {
  readonly value: unknown;
  readonly ancestors: ReadonlySet<object>;
};

/** Establish the complete JSON value contract for data arriving from an untyped source. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the shared JSON input guard.
export function isJsonValue(value: unknown): value is JsonValue {
  const pending: PendingJsonValue[] = [{ value, ancestors: new Set<object>() }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) return false;
    const candidate = current.value;
    if (candidate === null) continue;
    switch (typeof candidate) {
      case "string":
      case "boolean":
        continue;
      case "number":
        if (Number.isFinite(candidate)) continue;
        return false;
      case "object": {
        if (current.ancestors.has(candidate)) return false;
        const ancestors = new Set([...current.ancestors, candidate]);
        const values: readonly unknown[] = Array.isArray(candidate)
          ? candidate
          : Object.values(candidate);
        for (const child of values) {
          pending.push({ value: child, ancestors });
        }
        continue;
      }
      case "bigint":
      case "function":
      case "symbol":
      case "undefined":
        return false;
    }
    return false;
  }
  return true;
}

/** Parse a JSON value returned by JSON.parse without allowing an untyped representation inward. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON.parse is the I/O boundary.
export function parseJsonValue(value: unknown): JsonValue {
  if (!isJsonValue(value)) {
    throw new TypeError("value is not a JSON value");
  }
  return value;
}

export function isJsonObjectValue(value: JsonValue | undefined): value is JsonObject {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isJsonPrimitive(value: JsonValue): value is JsonPrimitive {
  return value === null || typeof value !== "object";
}

export function isJsonString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}
