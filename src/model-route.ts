/// <reference types="@cloudflare/workers-types" />

import { WorkerEntrypoint } from "cloudflare:workers";
import { streamModelEvents, streamingBindingCall } from "./model-route-stream.js";

export { streamModelEvents, encodeModelRouteResponseAsStream } from "./model-route-stream.js";
export type {
  ModelStreamEvent,
  ModelStreamInference,
  ModelUsage,
  StreamingProviderPayload,
  ToolCallDelta,
} from "./model-route-events.js";

// The only model the immutable host selects. An instruction model, not a reasoning one: deployed
// turns against `@cf/zai-org/glm-5.3-flash` saved an empty assistant message every time, because
// that model answers in `reasoning_content` and spent its whole budget there.
export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;
const REASONING_EFFORT = "low" as const;
/** Workers AI's default output budget truncates a turn's first tool call into nothing. */
const MAX_OUTPUT_TOKENS = 4096;
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

export type SystemMessage = Readonly<{ role: "system"; content: string }>;
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

// -- Request / Response / Validation ----------------------------------------

export type ModelRouteRequest = Readonly<{
  messages: ReadonlyArray<RouteMessage>;
  tools?: ReadonlyArray<ToolDefinition>;
}>;
export type ModelRouteResponse =
  | Readonly<{ ok: true; message: AssistantMessage }>
  | Readonly<{ ok: false; error: Readonly<{ code: "model-unavailable" }> }>;
export type ValidationFailure = Readonly<{
  ok: false;
  error: Readonly<{ code: "invalid-request"; reason: string }>;
}>;

// -- Provider payload (internal) --------------------------------------------

export type ProviderPayload = Readonly<{
  messages: ReadonlyArray<RouteMessage>;
  tools?: ReadonlyArray<ToolDefinition>;
  reasoning_effort: "low";
  max_tokens: number;
}>;
export type ProviderResult = Readonly<{
  response?: string | null;
  tool_calls?: ReadonlyArray<ToolCall>;
}>;
export type ModelInference = {
  run(model: string, input: ProviderPayload): Promise<ProviderResult>;
};

// -- Untrusted boundary accessor ---------------------------------------------
//
// Shared with `model-route-stream.ts`, which parses the provider's own untrusted stream chunks
// with the same accessors rather than a second copy of this narrowing.

declare const untrustedBrand: unique symbol;
/** Parsed JSON object whose fields have not been validated yet. */
export type UntrustedObject = object & { readonly [untrustedBrand]: never };

// oxlint-disable-next-line anti-slop/no-object-parameters -- Boundary: accepts the narrowed object from a typeof guard.
export function asUntrusted(value: object): UntrustedObject {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: caller confirmed object and non-null.
  return value as UntrustedObject;
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- Boundary accessor: returns the raw value for the caller to narrow.
export function field(obj: UntrustedObject, key: string): unknown {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-unsafe-dictionary-type -- SAFETY: branded untrusted object; Record<string, unknown> is the correct representation for an unvalidated JSON object whose fields the caller will narrow.
  return (obj as Record<string, unknown>)[key];
}

export function hasOwn(obj: UntrustedObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// -- Validation (pure, plain values per ADR-0035) ---------------------------

function fail(reason: string): ValidationFailure {
  return { ok: false, error: { code: "invalid-request", reason } };
}

function validateToolCallEntry(
  tc: UntrustedObject,
  tcIdx: number,
  msgIdx: number,
): ValidationFailure | null {
  const id = field(tc, "id");
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted tool call id.
  if (typeof id !== "string" || id === "") {
    return fail(`tool_calls[${tcIdx}] at messages[${msgIdx}] missing non-empty id`);
  }
  const fn = field(tc, "function");
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted function field.
  if (fn === null || fn === undefined || typeof fn !== "object") {
    return fail(`tool_calls[${tcIdx}] at messages[${msgIdx}] missing function`);
  }
  const fnObj = asUntrusted(fn);
  const name = field(fnObj, "name");
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted function.name.
  if (typeof name !== "string" || name === "") {
    return fail(`tool_calls[${tcIdx}] at messages[${msgIdx}] missing function.name`);
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted function.arguments.
  if (typeof field(fnObj, "arguments") !== "string") {
    return fail(`tool_calls[${tcIdx}] at messages[${msgIdx}] missing function.arguments`);
  }
  return null;
}

function validateAssistantToolCalls(calls: unknown[], index: number): ValidationFailure | null {
  for (let i = 0; i < calls.length; i++) {
    const entry: unknown = calls[i];
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: each tool call is untrusted.
    if (entry === null || typeof entry !== "object") {
      return fail(`tool_calls[${i}] at messages[${index}] is not an object`);
    }
    const tcErr = validateToolCallEntry(asUntrusted(entry), i, index);
    if (tcErr !== null) return tcErr;
  }
  return null;
}

function validateAssistant(msg: UntrustedObject, index: number): ValidationFailure | null {
  const content = field(msg, "content");
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted assistant content.
  if (content !== null && typeof content !== "string") {
    return fail(`assistant message at messages[${index}] content must be string or null`);
  }
  if (!hasOwn(msg, "tool_calls")) return null;
  const calls = field(msg, "tool_calls");
  if (!Array.isArray(calls)) {
    return fail(`assistant message at messages[${index}] tool_calls must be an array`);
  }
  return validateAssistantToolCalls(calls, index);
}

function validateToolMsg(msg: UntrustedObject, index: number): ValidationFailure | null {
  const tcId = field(msg, "tool_call_id");
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted tool_call_id.
  if (typeof tcId !== "string" || tcId === "") {
    return fail(`tool message at messages[${index}] missing non-empty tool_call_id`);
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted tool content.
  if (typeof field(msg, "content") !== "string") {
    return fail(`tool message at messages[${index}] content must be a string`);
  }
  return null;
}

function validateMessage(msg: UntrustedObject, index: number): ValidationFailure | null {
  const role = field(msg, "role");
  if (role === "system" || role === "user") {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: content on system/user msg.
    if (typeof field(msg, "content") !== "string") {
      return fail(`${role} message at messages[${index}] content must be a string`);
    }
    return null;
  }
  if (role === "assistant") return validateAssistant(msg, index);
  if (role === "tool") return validateToolMsg(msg, index);
  return fail(`unknown role ${JSON.stringify(role)} at messages[${index}]`);
}

function validateMessages(msgs: unknown[]): ValidationFailure | null {
  for (let i = 0; i < msgs.length; i++) {
    const entry: unknown = msgs[i];
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: each message entry.
    if (entry === null || typeof entry !== "object") return fail(`messages[${i}] is not an object`);
    const err = validateMessage(asUntrusted(entry), i);
    if (err !== null) return err;
  }
  return null;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: this IS the parse boundary for untrusted service-binding input.
export function validateRequest(raw: unknown): Readonly<{ ok: true }> | ValidationFailure {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: top-level input check.
  if (raw === null || typeof raw !== "object") return fail("request must be an object");
  const obj = asUntrusted(raw);
  for (const f of FORBIDDEN_FIELDS) {
    if (hasOwn(obj, f)) return fail(`request must not include provider field: ${f}`);
  }
  const msgs = field(obj, "messages");
  if (!Array.isArray(msgs) || msgs.length === 0) return fail("messages must be a non-empty array");
  // Bound the request by its actual wire size. `JSON.stringify(...).length` counts UTF-16 code
  // units, which under-counts every non-ASCII character once it crosses the wire as UTF-8 (most
  // are 2-3 bytes in UTF-8 but 1 code unit each here), so a payload that looked within budget by
  // string length could still exceed it in bytes.
  if (REQUEST_BYTES.encode(JSON.stringify(raw)).length > MAX_REQUEST_BYTES)
    return fail("request exceeds 1 MiB size limit");
  return validateMessages(msgs) ?? { ok: true };
}

// -- Provider payload construction ------------------------------------------

export function buildProviderPayload(request: ModelRouteRequest): ProviderPayload {
  const fixed = { reasoning_effort: REASONING_EFFORT, max_tokens: MAX_OUTPUT_TOKENS } as const;
  return request.tools === undefined
    ? { messages: request.messages, ...fixed }
    : { messages: request.messages, tools: request.tools, ...fixed };
}

// -- Response normalization -------------------------------------------------

export function normalizeResponse(raw: ProviderResult): AssistantMessage {
  const content = raw.response ?? null;
  const toolCalls: ToolCall[] = [];
  if (raw.tool_calls !== undefined) {
    for (const tc of raw.tool_calls) {
      toolCalls.push({
        id: tc.id,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      });
    }
  }
  return { role: "assistant", content, tool_calls: toolCalls };
}

// -- Core invocation --------------------------------------------------------

export async function invokeModel(
  ai: ModelInference,
  request: ModelRouteRequest,
): Promise<ModelRouteResponse> {
  try {
    return {
      ok: true,
      message: normalizeResponse(await ai.run(MODEL, buildProviderPayload(request))),
    };
  } catch {
    return { ok: false, error: { code: "model-unavailable" } };
  }
}

// -- Service binding entrypoint ---------------------------------------------

type ModelRouteEnv = Readonly<{ AI: Ai }>;

export class ModelRoute extends WorkerEntrypoint<ModelRouteEnv> {
  /** @deprecated Buffered path for the legacy `runGeneration0Turn` (T7 deletes it); delete this with {@link ModelInference} and {@link invokeModel} once that caller is gone. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: service-binding input is untrusted.
  run(request: unknown): Promise<ModelRouteResponse | ValidationFailure> {
    const validation = validateRequest(request);
    if (!validation.ok) return Promise.resolve(validation);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: validateRequest checked every field of the closed message union.
    const validated = request as ModelRouteRequest;
    return invokeModel({ run: (model, input) => this.env.AI.run(model, input) }, validated);
  }

  /** The streaming path (E5, E7): incremental events instead of one buffered message. Every
   * failure after validation becomes an event on the returned stream, which is what lets this
   * cross the RPC boundary as a plain byte stream (ADR-0035), like `MainFacetTarget.startTurn`. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: service-binding input is untrusted.
  runStream(request: unknown): ReadableStream<Uint8Array> | ValidationFailure {
    const validation = validateRequest(request);
    if (!validation.ok) return validation;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: validateRequest checked every field of the closed message union.
    const validated = request as ModelRouteRequest;
    return streamModelEvents(
      { run: (model, input) => streamingBindingCall(this.env.AI, model, input) },
      validated,
    );
  }
}
