import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const MAX_REQUEST_BYTES = 1_048_576;

const REQUEST_BYTES = new TextEncoder();

const FORBIDDEN_FIELDS: readonly string[] = [
  "model",
  "reasoning_effort",
  "credentials",
  "endpoint",
  "provider",
];

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

export type ModelRouteRequest = Readonly<{
  messages: ReadonlyArray<RouteMessage>;
  tools?: ReadonlyArray<ToolDefinition>;
}>;

export type ValidationFailure = Readonly<{
  ok: false;
  error: Readonly<{ code: "invalid-request"; reason: string }>;
}>;

export type RouteWire = ModelRouteRequest | Schema.Json;

type Parsed<T> = Result.Result<T, string>;

const FieldsSchema = Schema.Record(Schema.String, Schema.Unknown);

type Fields = typeof FieldsSchema.Type;

const isFields = Schema.is(FieldsSchema);

const EntriesSchema = Schema.Array(Schema.Unknown);

type Entries = typeof EntriesSchema.Type;

const isEntries = Schema.is(EntriesSchema);

const isString = Schema.is(Schema.String);

const isNonEmptyString = Schema.is(Schema.NonEmptyString);

function parseEach<T>(
  entries: Entries,
  label: (index: number) => string,
  parse: (entry: Fields, at: string) => Parsed<T>,
): Parsed<readonly T[]> {
  const parsed: T[] = [];

  for (const [index, entry] of entries.entries()) {
    if (!isFields(entry)) return Result.fail(`${label(index)} is not an object`);
    const result = parse(entry, label(index));

    if (Result.isFailure(result)) return Result.fail(result.failure);
    parsed.push(result.success);
  }

  return Result.succeed(parsed);
}

function parseToolCall(call: Fields, at: string): Parsed<ToolCall> {
  const id = call.id;

  if (!isNonEmptyString(id)) return Result.fail(`${at} missing non-empty id`);
  const fn = call.function;

  if (!isFields(fn)) return Result.fail(`${at} missing function`);
  const name = fn.name;

  if (!isNonEmptyString(name)) return Result.fail(`${at} missing function.name`);
  const args = fn.arguments;

  if (!isString(args)) return Result.fail(`${at} missing function.arguments`);

  return Result.succeed({ id, function: { name, arguments: args } });
}

function parseAssistant(msg: Fields, at: string): Parsed<AssistantMessage> {
  const content = msg.content;

  if (content !== null && !isString(content)) {
    return Result.fail(`assistant message at ${at} content must be string or null`);
  }

  if (!Object.hasOwn(msg, "tool_calls"))
    return Result.succeed({ role: "assistant", content, tool_calls: [] });
  const calls = msg.tool_calls;

  if (!isEntries(calls)) {
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

function parseToolResult(msg: Fields, at: string): Parsed<ToolResultMessage> {
  const toolCallId = msg.tool_call_id;

  if (!isNonEmptyString(toolCallId)) {
    return Result.fail(`tool message at ${at} missing non-empty tool_call_id`);
  }

  const content = msg.content;

  if (!isString(content)) return Result.fail(`tool message at ${at} content must be a string`);

  return Result.succeed({ role: "tool", tool_call_id: toolCallId, content });
}

function parseMessage(msg: Fields, at: string): Parsed<RouteMessage> {
  const role = msg.role;

  if (role === "system" || role === "user") {
    const content = msg.content;

    if (!isString(content)) return Result.fail(`${role} message at ${at} content must be a string`);

    return Result.succeed({ role, content });
  }

  if (role === "assistant") return parseAssistant(msg, at);

  if (role === "tool") return parseToolResult(msg, at);

  return Result.fail(`unknown role ${JSON.stringify(role)} at ${at}`);
}

function parseTool(tool: Fields, at: string): Parsed<ToolDefinition> {
  if (tool.type !== "function") return Result.fail(`${at} type must be "function"`);
  const fn = tool.function;

  if (!isFields(fn)) return Result.fail(`${at} missing function`);
  const name = fn.name;

  if (!isNonEmptyString(name)) return Result.fail(`${at} missing function.name`);
  const description = fn.description;

  if (!isString(description)) return Result.fail(`${at} function.description must be a string`);
  const parameters = fn.parameters;

  if (!isFields(parameters)) return Result.fail(`${at} function.parameters must be an object`);

  return Result.succeed({ type: "function", function: { name, description, parameters } });
}

function parseFields(raw: RouteWire): Parsed<ModelRouteRequest> {
  if (!isFields(raw)) return Result.fail("request must be an object");

  for (const f of FORBIDDEN_FIELDS) {
    if (Object.hasOwn(raw, f)) return Result.fail(`request must not include provider field: ${f}`);
  }

  const msgs = raw.messages;

  if (!isEntries(msgs) || msgs.length === 0) {
    return Result.fail("messages must be a non-empty array");
  }

  if (REQUEST_BYTES.encode(JSON.stringify(raw)).length > MAX_REQUEST_BYTES) {
    return Result.fail("request exceeds 1 MiB size limit");
  }

  return Result.gen(function* () {
    const messages = yield* parseEach(msgs, (index) => `messages[${index}]`, parseMessage);
    const tools = raw.tools;

    if (tools === undefined) return { messages };

    if (!isEntries(tools)) return yield* Result.fail("tools must be an array");

    return { messages, tools: yield* parseEach(tools, (index) => `tools[${index}]`, parseTool) };
  });
}

export function parseRequest(raw: RouteWire): Result.Result<ModelRouteRequest, ValidationFailure> {
  return Result.mapError(parseFields(raw), (reason): ValidationFailure => ({
    ok: false,
    error: { code: "invalid-request", reason },
  }));
}
