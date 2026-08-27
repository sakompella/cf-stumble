import { isJsonObjectValue, parseJsonValue, type JsonObject, type JsonValue } from "../../json.js";
import type { RecordedModelResponse } from "../../replay/schema.js";

export type ParsedModelResponse =
  | { readonly kind: "final"; readonly content: string }
  | { readonly kind: "tool-calls"; readonly calls: readonly ParsedToolCall[] };

export type ParsedToolCall = {
  readonly name: string;
  readonly arguments: JsonValue;
};

export type ModelResponseParseResult =
  | { readonly ok: true; readonly response: ParsedModelResponse }
  | { readonly ok: false; readonly detail: string };

/**
 * Parse the small JSON protocol understood by the runtime:
 * `{ "type": "final", "content": "..." }` or
 * `{ "type": "tool_call", "name": "write", "arguments": { ... } }`.
 */
export function parseAgentResponse(response: RecordedModelResponse): ModelResponseParseResult {
  let value: JsonValue;
  try {
    value = parseJsonValue(JSON.parse(response.content));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `response is not valid JSON: ${detail}` };
  }
  if (Array.isArray(value)) {
    return parseToolCalls(value, "tool calls");
  }
  if (!isJsonObjectValue(value)) {
    return { ok: false, detail: "response must be a JSON object or tool-call array" };
  }

  const type = value.type;
  if (type === "final") {
    if (!isString(value.content)) {
      return { ok: false, detail: 'final response field "content" must be a string' };
    }
    return { ok: true, response: { kind: "final", content: value.content } };
  }
  if (type === "tool_call") {
    const call = parseToolCall(value, "tool call");
    return call.ok ? { ok: true, response: { kind: "tool-calls", calls: [call.call] } } : call;
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
  return {
    ok: false,
    detail: 'response field "type" must be "final", "tool_call", or "tool_calls"',
  };
}

function parseToolCalls(value: JsonValue | undefined, path: string): ModelResponseParseResult {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, detail: `${path} must be a non-empty array` };
  }
  const calls: ParsedToolCall[] = [];
  const callValues: readonly JsonValue[] = value;
  for (const [index, item] of callValues.entries()) {
    const call = parseToolCall(item, `${path}[${index}]`);
    if (!call.ok) {
      return call;
    }
    calls.push(call.call);
  }
  return { ok: true, response: { kind: "tool-calls", calls } };
}

function parseToolCall(
  value: JsonValue | undefined,
  path: string,
):
  | { readonly ok: true; readonly call: ParsedToolCall }
  | { readonly ok: false; readonly detail: string } {
  if (!isJsonObjectValue(value)) {
    return { ok: false, detail: `${path} must be an object` };
  }
  if (!("name" in value) && isJsonObjectValue(value.function)) {
    return parseToolCall(value.function, `${path}.function`);
  }
  const name = value.name;
  if (!isString(name) || name.length === 0) {
    return { ok: false, detail: `${path} field "name" must be a non-empty string` };
  }
  if (!("arguments" in value)) {
    return { ok: false, detail: `${path} field "arguments" is required` };
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
    return {
      ok: false,
      detail: `${path} field ${JSON.stringify(nameKey)} must be a non-empty string`,
    };
  }
  if ("arguments" in value) {
    const call = parseNamedArguments(name, value.arguments, path);
    return call.ok ? { ok: true, response: { kind: "tool-calls", calls: [call.call] } } : call;
  }
  const argumentEntries: [string, JsonValue][] = [];
  for (const [key, argument] of Object.entries(value)) {
    if (key !== nameKey && key !== "type") {
      argumentEntries.push([key, argument]);
    }
  }
  const argumentsObject: JsonObject = Object.fromEntries(argumentEntries);
  return {
    ok: true,
    response: { kind: "tool-calls", calls: [{ name, arguments: argumentsObject }] },
  };
}

function parseNamedArguments(
  name: string,
  value: JsonValue,
  path: string,
):
  | { readonly ok: true; readonly call: ParsedToolCall }
  | { readonly ok: false; readonly detail: string } {
  let args = value;
  if (isString(args)) {
    try {
      args = parseJsonValue(JSON.parse(args));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        detail: `${path} field "arguments" is not valid JSON: ${detail}`,
      };
    }
  }
  return { ok: true, call: { name, arguments: args } };
}

function isString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}
