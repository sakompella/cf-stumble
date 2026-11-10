import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export type JsonValue = Schema.Json;

export type JsonRecord = Schema.JsonObject;

export function isJsonRecord(value: JsonValue): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonString(value: JsonValue): value is string {
  return typeof value === "string";
}

const decodeRecordText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.JsonObject));

export function parseJsonRecordText(text: string): JsonRecord | undefined {
  return Option.getOrUndefined(decodeRecordText(text));
}
