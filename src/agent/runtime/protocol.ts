import type { RecordedModelResponse } from "../../replay/schema.js";

export type ParsedModelResponse =
  | { readonly kind: "final"; readonly content: string }
  | { readonly kind: "tool-calls"; readonly calls: readonly ParsedToolCall[] };

export type ParsedToolCall = {
  readonly name: string;
  readonly arguments: unknown;
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
  let value: unknown;
  try {
    value = JSON.parse(response.content);
  } catch (error: unknown) {
    return { ok: false, detail: `response is not valid JSON: ${errorDetail(error)}` };
  }
  if (Array.isArray(value)) {
    return parseToolCalls(value, "tool calls");
  }
  if (!isRecord(value)) {
    return { ok: false, detail: "response must be a JSON object or tool-call array" };
  }

  const type = value.type;
  if (type === "final") {
    if (typeof value.content !== "string") {
      return { ok: false, detail: 'final response field "content" must be a string' };
    }
    return { ok: true, response: { kind: "final", content: value.content } };
  }
  if (type === "tool_call") {
    const call = parseToolCall(value, "tool call");
    return call.ok
      ? { ok: true, response: { kind: "tool-calls", calls: [call.call] } }
      : call;
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
  if (typeof value.kind === "string") {
    return parseDirectToolCall(value, "tool call", "kind");
  }
  return { ok: false, detail: 'response field "type" must be "final", "tool_call", or "tool_calls"' };
}

function parseToolCalls(value: unknown, path: string): ModelResponseParseResult {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, detail: `${path} must be a non-empty array` };
  }
  const calls: ParsedToolCall[] = [];
  for (const [index, item] of value.entries()) {
    const call = parseToolCall(item, `${path}[${index}]`);
    if (!call.ok) {
      return call;
    }
    calls.push(call.call);
  }
  return { ok: true, response: { kind: "tool-calls", calls } };
}

function parseToolCall(value: unknown, path: string):
  | { readonly ok: true; readonly call: ParsedToolCall }
  | { readonly ok: false; readonly detail: string } {
  if (!isRecord(value)) {
    return { ok: false, detail: `${path} must be an object` };
  }
  if (!("name" in value) && isRecord(value.function)) {
    return parseToolCall(value.function, `${path}.function`);
  }
  const name = value.name;
  if (typeof name !== "string" || name.length === 0) {
    return { ok: false, detail: `${path} field "name" must be a non-empty string` };
  }
  if (!("arguments" in value)) {
    return { ok: false, detail: `${path} field "arguments" is required` };
  }
  return parseNamedArguments(name, value.arguments, path);
}

function parseDirectToolCall(
  value: Record<string, unknown>,
  path: string,
  nameKey: string,
): ModelResponseParseResult {
  const name = value[nameKey];
  if (typeof name !== "string" || name.length === 0) {
    return { ok: false, detail: `${path} field ${JSON.stringify(nameKey)} must be a non-empty string` };
  }
  if ("arguments" in value) {
    const call = parseNamedArguments(name, value.arguments, path);
    return call.ok ? { ok: true, response: { kind: "tool-calls", calls: [call.call] } } : call;
  }
  const argumentsObject: Record<string, unknown> = {};
  for (const [key, argument] of Object.entries(value)) {
    if (key !== nameKey && key !== "type") {
      argumentsObject[key] = argument;
    }
  }
  return { ok: true, response: { kind: "tool-calls", calls: [{ name, arguments: argumentsObject }] } };
}

function parseNamedArguments(
  name: string,
  value: unknown,
  path: string,
): { readonly ok: true; readonly call: ParsedToolCall } | { readonly ok: false; readonly detail: string } {
  let args = value;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch (error: unknown) {
      return {
        ok: false,
        detail: `${path} field "arguments" is not valid JSON: ${errorDetail(error)}`,
      };
    }
  }
  return { ok: true, call: { name, arguments: args } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
