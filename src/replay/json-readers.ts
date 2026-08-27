import { isJsonObjectValue, type JsonObject, type JsonValue } from "../json.js";
import { ReplaySchemaError } from "./schema.js";

export function readRecord(value: JsonValue | undefined, path: string): JsonObject {
  if (!isJsonObjectValue(value)) {
    throw new ReplaySchemaError(path, "must be an object");
  }
  return value;
}

function isString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

export function readString(value: JsonValue | undefined, path: string): string {
  if (!isString(value)) {
    throw new ReplaySchemaError(path, "must be a string");
  }
  return value;
}

export function readNonEmptyString(value: JsonValue | undefined, path: string): string {
  const string = readString(value, path);
  if (string.length === 0) {
    throw new ReplaySchemaError(path, "must not be empty");
  }
  return string;
}

export function readArray(value: JsonValue | undefined, path: string): readonly JsonValue[] {
  if (!Array.isArray(value)) {
    throw new ReplaySchemaError(path, "must be an array");
  }
  const array: readonly JsonValue[] = value;
  return array;
}

function isFiniteNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function readFiniteNumber(value: JsonValue | undefined, path: string): number {
  if (!isFiniteNumber(value)) {
    throw new ReplaySchemaError(path, "must be a finite number");
  }
  return value;
}

export function readInteger(value: JsonValue | undefined, path: string): number {
  const number = readFiniteNumber(value, path);
  if (!Number.isInteger(number)) {
    throw new ReplaySchemaError(path, "must be an integer");
  }
  return number;
}
