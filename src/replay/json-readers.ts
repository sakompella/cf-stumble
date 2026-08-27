import { Result } from "better-result";
import { isJsonObjectValue, type JsonObject, type JsonValue } from "../json.js";
import { ReplaySchemaError } from "./schema.js";

export function readRecord(
  value: JsonValue | undefined,
  path: string,
): Result<JsonObject, ReplaySchemaError> {
  if (!isJsonObjectValue(value)) {
    return Result.err(new ReplaySchemaError({ path, condition: "must be an object" }));
  }
  return Result.ok(value);
}

function isString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

export function readString(
  value: JsonValue | undefined,
  path: string,
): Result<string, ReplaySchemaError> {
  if (!isString(value)) {
    return Result.err(new ReplaySchemaError({ path, condition: "must be a string" }));
  }
  return Result.ok(value);
}

export function readNonEmptyString(
  value: JsonValue | undefined,
  path: string,
): Result<string, ReplaySchemaError> {
  return Result.gen(function* () {
    const string = yield* readString(value, path);
    if (string.length === 0) {
      return Result.err(new ReplaySchemaError({ path, condition: "must not be empty" }));
    }
    return Result.ok(string);
  });
}

export function readArray(
  value: JsonValue | undefined,
  path: string,
): Result<readonly JsonValue[], ReplaySchemaError> {
  if (!Array.isArray(value)) {
    return Result.err(new ReplaySchemaError({ path, condition: "must be an array" }));
  }
  const array: readonly JsonValue[] = value;
  return Result.ok(array);
}

function isFiniteNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function readFiniteNumber(
  value: JsonValue | undefined,
  path: string,
): Result<number, ReplaySchemaError> {
  if (!isFiniteNumber(value)) {
    return Result.err(new ReplaySchemaError({ path, condition: "must be a finite number" }));
  }
  return Result.ok(value);
}

export function readInteger(
  value: JsonValue | undefined,
  path: string,
): Result<number, ReplaySchemaError> {
  return Result.gen(function* () {
    const number = yield* readFiniteNumber(value, path);
    if (!Number.isInteger(number)) {
      return Result.err(new ReplaySchemaError({ path, condition: "must be an integer" }));
    }
    return Result.ok(number);
  });
}
