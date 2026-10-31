import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type JsonValue = Schema.Json;

export type JsonRecord = Schema.JsonObject;

const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

export function parseJsonText(text: string): JsonValue | undefined {
  return Option.getOrUndefined(decodeJsonText(text));
}

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

export function parseJsonRecordText(text: string): JsonRecord | undefined {
  const parsed = parseJsonText(text);

  return parsed !== undefined && isJsonRecord(parsed) ? parsed : undefined;
}
