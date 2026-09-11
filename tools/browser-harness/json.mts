/**
 * JSON as a closed type, and the two guards that open it.
 *
 * The harness handles JSON from two directions: DevTools replies coming in, and stub API payloads
 * going out. Both are JSON and nothing wider, so neither needs `unknown`. Stating that here once
 * keeps every reader in the harness working with a value contract instead of an escape hatch.
 */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonRecord;

export type JsonRecord = { readonly [key: string]: JsonValue };

export function isJsonRecord(value: JsonValue): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

export function isJsonString(value: JsonValue): value is string {
  return typeof value === "string";
}

export function isJsonNumber(value: JsonValue): value is number {
  return typeof value === "number";
}

/** Parse text that should be a JSON object, answering `undefined` when it is anything else. */
export function parseJsonRecordText(text: string): JsonRecord | undefined {
  try {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: JSON.parse returns only JSON, which JsonValue describes exactly, and isJsonRecord then proves this one is an object.
    const parsed = JSON.parse(text) as JsonValue;

    return isJsonRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
