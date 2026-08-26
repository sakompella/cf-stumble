export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;

export type JsonObject = {
  readonly [key: string]: JsonValue;
};

/** Establish the complete JSON value contract for data arriving from an untyped source. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the shared JSON input guard.
export function isJsonValue(value: unknown): value is JsonValue {
  return isJsonValueWithin(value, new Set<object>());
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- recursive JSON validation still starts from an untrusted value.
function isJsonValueWithin(value: unknown, ancestors: ReadonlySet<object>): value is JsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object": {
      if (ancestors.has(value)) return false;
      const nextAncestors = new Set([...ancestors, value]);
      const values: readonly unknown[] = Array.isArray(value) ? value : Object.values(value);
      return values.every((entry) => isJsonValueWithin(entry, nextAncestors));
    }
    case "bigint":
    case "function":
    case "symbol":
    case "undefined":
      return false;
  }
  return false;
}

/** Parse a JSON value returned by JSON.parse without allowing an untyped representation inward. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON.parse is the I/O boundary.
export function parseJsonValue(value: unknown): JsonValue {
  if (!isJsonValue(value)) {
    throw new TypeError("value is not a JSON value");
  }
  return value;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this guard validates an object boundary.
export function isJsonObject(value: unknown): value is JsonObject {
  return isJsonValue(value) && !Array.isArray(value) && typeof value === "object" && value !== null;
}

export function isJsonPrimitive(value: JsonValue): value is JsonPrimitive {
  return value === null || typeof value !== "object";
}
