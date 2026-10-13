/**
 * The model route's request: the closed message union a facet may send, and the parser that turns
 * untrusted service-binding input into it. `./model-route.ts` holds the entrypoint that uses it.
 */

import * as Result from "effect/Result";
import { asUntrusted, field, hasOwn, isRecord, type UntrustedObject } from "./untrusted.js";

const MAX_REQUEST_BYTES = 1_048_576;

/** Shared encoder for the byte-size checks below; UTF-8 byte length, not `string.length`. */
const REQUEST_BYTES = new TextEncoder();

const FORBIDDEN_FIELDS: readonly string[] = [
  "model",
  "reasoning_effort",
  "credentials",
  "endpoint",
  "provider",
];

// -- Closed message union ---------------------------------------------------

type SystemMessage = Readonly<{ role: "system"; content: string }>;

export type UserMessage = Readonly<{ role: "user"; content: string }>;

export type ToolCall = Readonly<{
  id: string;
  function: Readonly<{ name: string; arguments: string }>;
}>;

export type AssistantMessage = Readonly<{
  role: "assistant";
  content: string | null;
  tool_calls: ReadonlyArray<ToolCall>;
}>;

export type ToolResultMessage = Readonly<{
  role: "tool";
  tool_call_id: string;
  content: string;
}>;

export type RouteMessage = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export type ToolDefinition = Readonly<{
  type: "function";
  function: Readonly<{ name: string; description: string; parameters: object }>;
}>;

// -- Request ----------------------------------------------------------------

export type ModelRouteRequest = Readonly<{
  messages: ReadonlyArray<RouteMessage>;
  tools?: ReadonlyArray<ToolDefinition>;
}>;

export type ValidationFailure = Readonly<{
  ok: false;
  error: Readonly<{ code: "invalid-request"; reason: string }>;
}>;

// -- Parsing (pure, plain values per ADR-0045) ------------------------------

/** One parse step's value, or the reason the request is invalid. */
type Parsed<T> = Result.Result<T, string>;

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: one untrusted request value.
function untrustedRecord(value: unknown): UntrustedObject | undefined {
  return isRecord(value) ? asUntrusted(value) : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Parse every entry of an untrusted array as an object, stopping at the first invalid one. */
function parseEach<T>(
  entries: readonly unknown[],
  label: (index: number) => string,
  parse: (entry: UntrustedObject, at: string) => Parsed<T>,
): Parsed<readonly T[]> {
  const parsed: T[] = [];

  for (const [index, value] of entries.entries()) {
    const entry = untrustedRecord(value);

    if (entry === undefined) return Result.fail(`${label(index)} is not an object`);
    const result = parse(entry, label(index));

    if (Result.isFailure(result)) return Result.fail(result.failure);
    parsed.push(result.success);
  }

  return Result.succeed(parsed);
}

function parseToolCall(call: UntrustedObject, at: string): Parsed<ToolCall> {
  const id = field(call, "id");

  if (!isNonEmptyString(id)) return Result.fail(`${at} missing non-empty id`);
  const fn = untrustedRecord(field(call, "function"));

  if (fn === undefined) return Result.fail(`${at} missing function`);
  const name = field(fn, "name");

  if (!isNonEmptyString(name)) return Result.fail(`${at} missing function.name`);
  const args = field(fn, "arguments");

  if (!isString(args)) return Result.fail(`${at} missing function.arguments`);

  return Result.succeed({ id, function: { name, arguments: args } });
}

/** An assistant message may omit `tool_calls`; it then has none. */
function parseAssistant(msg: UntrustedObject, at: string): Parsed<AssistantMessage> {
  const content = field(msg, "content");

  if (content !== null && !isString(content)) {
    return Result.fail(`assistant message at ${at} content must be string or null`);
  }

  if (!hasOwn(msg, "tool_calls"))
    return Result.succeed({ role: "assistant", content, tool_calls: [] });
  const calls = field(msg, "tool_calls");

  if (!Array.isArray(calls)) {
    return Result.fail(`assistant message at ${at} tool_calls must be an array`);
  }

  return Result.gen(function* () {
    const toolCalls = yield* parseEach(
      calls,
      (index) => `tool_calls[${index}] at ${at}`,
      parseToolCall,
    );

    const message: AssistantMessage = { role: "assistant", content, tool_calls: toolCalls };

    return message;
  });
}

function parseToolResult(msg: UntrustedObject, at: string): Parsed<ToolResultMessage> {
  const toolCallId = field(msg, "tool_call_id");

  if (!isNonEmptyString(toolCallId)) {
    return Result.fail(`tool message at ${at} missing non-empty tool_call_id`);
  }

  const content = field(msg, "content");

  if (!isString(content)) return Result.fail(`tool message at ${at} content must be a string`);

  return Result.succeed({ role: "tool", tool_call_id: toolCallId, content });
}

function parseMessage(msg: UntrustedObject, at: string): Parsed<RouteMessage> {
  const role = field(msg, "role");

  if (role === "system" || role === "user") {
    const content = field(msg, "content");

    if (!isString(content)) return Result.fail(`${role} message at ${at} content must be a string`);

    return Result.succeed({ role, content });
  }

  if (role === "assistant") return parseAssistant(msg, at);

  if (role === "tool") return parseToolResult(msg, at);

  return Result.fail(`unknown role ${JSON.stringify(role)} at ${at}`);
}

/** The fields a provider needs from a tool; `parameters` stays the caller's JSON Schema object. */
function parseTool(tool: UntrustedObject, at: string): Parsed<ToolDefinition> {
  if (field(tool, "type") !== "function") return Result.fail(`${at} type must be "function"`);
  const fn = untrustedRecord(field(tool, "function"));

  if (fn === undefined) return Result.fail(`${at} missing function`);
  const name = field(fn, "name");

  if (!isNonEmptyString(name)) return Result.fail(`${at} missing function.name`);
  const description = field(fn, "description");

  if (!isString(description)) return Result.fail(`${at} function.description must be a string`);
  const parameters = field(fn, "parameters");

  if (!isRecord(parameters)) return Result.fail(`${at} function.parameters must be an object`);

  return Result.succeed({ type: "function", function: { name, description, parameters } });
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the untrusted `tools` field.
function parseTools(tools: unknown): Parsed<readonly ToolDefinition[]> {
  if (!Array.isArray(tools)) return Result.fail("tools must be an array");

  return parseEach(tools, (index) => `tools[${index}]`, parseTool);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the untrusted request.
function parseFields(raw: unknown): Parsed<ModelRouteRequest> {
  const obj = untrustedRecord(raw);

  if (obj === undefined) return Result.fail("request must be an object");

  for (const f of FORBIDDEN_FIELDS) {
    if (hasOwn(obj, f)) return Result.fail(`request must not include provider field: ${f}`);
  }

  const msgs = field(obj, "messages");

  if (!Array.isArray(msgs) || msgs.length === 0) {
    return Result.fail("messages must be a non-empty array");
  }

  // Bound the request by its actual wire size. `JSON.stringify(...).length` counts UTF-16 code
  // units, which under-counts every non-ASCII character once it crosses the wire as UTF-8 (most
  // are 2-3 bytes in UTF-8 but 1 code unit each here), so a payload that looked within budget by
  // string length could still exceed it in bytes.
  if (REQUEST_BYTES.encode(JSON.stringify(raw)).length > MAX_REQUEST_BYTES) {
    return Result.fail("request exceeds 1 MiB size limit");
  }

  return Result.gen(function* () {
    const messages = yield* parseEach(msgs, (index) => `messages[${index}]`, parseMessage);
    const tools = field(obj, "tools");

    if (tools === undefined) return { messages };

    return { messages, tools: yield* parseTools(tools) };
  });
}

/**
 * The request as the providers receive it, rebuilt from the fields checked here, so a field this
 * route does not know never reaches a provider.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: this IS the parse boundary for untrusted service-binding input.
export function parseRequest(raw: unknown): Result.Result<ModelRouteRequest, ValidationFailure> {
  return Result.mapError(parseFields(raw), (reason): ValidationFailure => ({
    ok: false,
    error: { code: "invalid-request", reason },
  }));
}
