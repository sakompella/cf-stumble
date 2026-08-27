import { Result } from "better-result";
import { isJsonObjectValue, parseJsonValue, type JsonObject, type JsonValue } from "../../json.js";
import type { RecordedModelResponse } from "../../replay/schema.js";
import { MalformedToolCallError } from "./model-errors.js";

export type ParsedModelResponse =
  | { readonly kind: "final"; readonly content: string }
  | { readonly kind: "tool-calls"; readonly calls: readonly ParsedToolCall[] };

export type ParsedToolCall = {
  readonly name: string;
  readonly arguments: JsonValue;
};

export type ModelResponseParseResult = Result<ParsedModelResponse, MalformedToolCallError>;

/**
 * Parse the small JSON protocol understood by the runtime:
 * `{ "type": "final", "content": "..." }` or
 * `{ "type": "tool_call", "name": "write", "arguments": { ... } }`.
 */
export function parseAgentResponse(response: RecordedModelResponse): ModelResponseParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.content);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return malformed(`response is not valid JSON: ${detail}`);
  }
  const json = parseJsonValue(parsed);
  if (Result.isError(json)) {
    return malformed(`response is not valid JSON: ${json.error.message}`);
  }
  const value = json.value;
  if (Array.isArray(value)) {
    return parseToolCalls(value, "tool calls");
  }
  if (!isJsonObjectValue(value)) {
    return malformed("response must be a JSON object or tool-call array");
  }

  const type = value.type;
  if (type === "final") {
    return isString(value.content)
      ? Result.ok({ kind: "final", content: value.content })
      : malformed('final response field "content" must be a string');
  }
  if (type === "tool_call") {
    const call = parseToolCall(value, "tool call");
    if (Result.isError(call)) {
      return call;
    }
    return Result.ok({ kind: "tool-calls", calls: [call.value] });
  }
  if (type === "tool_calls") {
    return parseToolCalls(value.calls ?? value.tool_calls, "tool calls");
  }
  if ("tool_calls" in value) {
    return parseToolCalls(value.tool_calls, "tool calls");
  }
  if ("tool" in value) {
    return parseDirectToolCall(value, "tool call", "tool");
  }
  if (isString(value.kind)) {
    return parseDirectToolCall(value, "tool call", "kind");
  }
  return malformed('response field "type" must be "final", "tool_call", or "tool_calls"');
}

function parseToolCalls(value: JsonValue | undefined, path: string): ModelResponseParseResult {
  if (!Array.isArray(value) || value.length === 0) {
    return malformed(`${path} must be a non-empty array`);
  }
  const calls: ParsedToolCall[] = [];
  const callValues: readonly JsonValue[] = value;
  for (const [index, item] of callValues.entries()) {
    const call = parseToolCall(item, `${path}[${index}]`);
    if (Result.isError(call)) {
      return call;
    }
    calls.push(call.value);
  }
  return Result.ok({ kind: "tool-calls", calls });
}

function parseToolCall(
  value: JsonValue | undefined,
  path: string,
): Result<ParsedToolCall, MalformedToolCallError> {
  if (!isJsonObjectValue(value)) {
    return malformed(`${path} must be an object`);
  }
  if (!("name" in value) && isJsonObjectValue(value.function)) {
    return parseToolCall(value.function, `${path}.function`);
  }
  const name = value.name;
  if (!isString(name) || name.length === 0) {
    return malformed(`${path} field "name" must be a non-empty string`);
  }
  if (!("arguments" in value)) {
    return malformed(`${path} field "arguments" is required`);
  }
  return parseNamedArguments(name, value.arguments, path);
}

function parseDirectToolCall(
  value: JsonObject,
  path: string,
  nameKey: string,
): ModelResponseParseResult {
  const name = value[nameKey];
  if (!isString(name) || name.length === 0) {
    return malformed(`${path} field ${JSON.stringify(nameKey)} must be a non-empty string`);
  }
  if ("arguments" in value) {
    const call = parseNamedArguments(name, value.arguments, path);
    if (Result.isError(call)) {
      return call;
    }
    return Result.ok({ kind: "tool-calls", calls: [call.value] });
  }
  const argumentEntries: [string, JsonValue][] = [];
  for (const [key, argument] of Object.entries(value)) {
    if (key !== nameKey && key !== "type") {
      argumentEntries.push([key, argument]);
    }
  }
  const argumentsObject: JsonObject = Object.fromEntries(argumentEntries);
  return Result.ok({ kind: "tool-calls", calls: [{ name, arguments: argumentsObject }] });
}

function parseNamedArguments(
  name: string,
  value: JsonValue,
  path: string,
): Result<ParsedToolCall, MalformedToolCallError> {
  let args = value;
  if (isString(args)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(args);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return malformed(`${path} field "arguments" is not valid JSON: ${detail}`);
    }
    const json = parseJsonValue(parsed);
    if (Result.isError(json)) {
      return malformed(`${path} field "arguments" is not valid JSON: ${json.error.message}`);
    }
    args = json.value;
  }
  return Result.ok({ name, arguments: args });
}

function malformed<T>(detail: string): Result<T, MalformedToolCallError> {
  return Result.err(new MalformedToolCallError({ detail }));
}

function isString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}
