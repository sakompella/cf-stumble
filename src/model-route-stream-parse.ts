/**
 * Defensive parsing of one provider Server-Sent Event chunk (E5, E7). This is the provider's own
 * untrusted output, so it gets the same boundary treatment `model-route.ts` gives untrusted
 * request input (ADR-0035): every field is narrowed before use, and an unrecognized shape
 * degrades to "nothing understood on this line" rather than throwing.
 *
 * UNVERIFIED against the real paid runtime (see `.audit/v0/tasks/T4.md`): whether
 * `@cf/zai-org/glm-5.3-flash` actually reports `tool_calls` incrementally, fragment by fragment,
 * or only complete in one final chunk. Either behavior parses correctly here — a
 * complete-in-one-chunk provider just means every tool call's `argumentsDelta` arrives in a
 * single `tool-call-delta` event instead of several.
 */

import { asUntrusted, field } from "./model-route.js";
import type { UntrustedObject } from "./model-route.js";
import type { ToolCallDelta } from "./model-route-events.js";

/** One provider stream chunk's fields this route understands, after defensive parsing. */
export type ParsedProviderChunk = Readonly<{
  textDelta?: string;
  toolCallDeltas?: ReadonlyArray<ToolCallDelta>;
  usage?: Readonly<{ inputTokens: number; outputTokens: number }>;
}>;

/** Same fields as {@link ParsedProviderChunk}, but mutable while this module builds one. */
type MutableParsedChunk = {
  textDelta?: string;
  toolCallDeltas?: ToolCallDelta[];
  usage?: Readonly<{ inputTokens: number; outputTokens: number }>;
};

/** The tool call function fields one provider chunk entry reports, before assembly into a delta. */
type ParsedToolCallFunction = Readonly<{ name?: string; argumentsDelta?: string }>;
/** Same fields as {@link ParsedToolCallFunction}, but mutable while this module builds one. */
type MutableToolCallFunction = { name?: string; argumentsDelta?: string };

/** Same fields as {@link ToolCallDelta}, but mutable while this module builds one. */
type MutableToolCallDelta = { index: number; id?: string; name?: string; argumentsDelta?: string };

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: one untrusted provider field.
function stringField(value: unknown): string | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted provider field.
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The `delta` of the first choice, for a provider that streams chat completions rather than
 * Workers AI's classic `{ response }` events.
 *
 * This is where a deployed turn was losing its whole answer. The model streams
 * `{"choices":[{"delta":{"content":"ready"}}]}` and reports its usage at the top level, so the
 * route recorded three output tokens and no text, and Pi saved an assistant message with nothing
 * in it. Only the first choice matters: the route never asks for more than one.
 */
function firstChoiceDelta(obj: UntrustedObject): UntrustedObject | undefined {
  const choices = field(obj, "choices");
  if (!Array.isArray(choices)) return undefined;
  const first: unknown = choices.at(0);
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted choice entry.
  if (first === null || typeof first !== "object") return undefined;
  const delta = field(asUntrusted(first), "delta");
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted delta field.
  return delta === null || typeof delta !== "object" ? undefined : asUntrusted(delta);
}

function numberField(obj: UntrustedObject, key: string): number | undefined {
  const value = field(obj, key);
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted provider chunk field.
  return typeof value === "number" ? value : undefined;
}

function parseProviderUsage(obj: UntrustedObject): ParsedProviderChunk["usage"] {
  const usageValue = field(obj, "usage");
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted provider usage field.
  if (usageValue === null || typeof usageValue !== "object") return undefined;
  const usageObj = asUntrusted(usageValue);
  const inputTokens =
    numberField(usageObj, "prompt_tokens") ?? numberField(usageObj, "input_tokens");
  const outputTokens =
    numberField(usageObj, "completion_tokens") ?? numberField(usageObj, "output_tokens");
  return inputTokens === undefined || outputTokens === undefined
    ? undefined
    : { inputTokens, outputTokens };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: one untrusted `function` field from the provider's own stream chunk.
function parseProviderToolCallFunction(fn: unknown): ParsedToolCallFunction {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted tool call function field.
  if (fn === null || typeof fn !== "object") return {};
  const fnObj = asUntrusted(fn);
  const fnName = field(fnObj, "name");
  const fnArgs = field(fnObj, "arguments");
  const parsed: MutableToolCallFunction = {};
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted function.name.
  if (typeof fnName === "string") parsed.name = fnName;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted function.arguments.
  if (typeof fnArgs === "string") parsed.argumentsDelta = fnArgs;
  return parsed satisfies ParsedToolCallFunction;
}

/** One untrusted tool call delta entry from the provider's own stream. */
function parseProviderToolCallDelta(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the provider's own untrusted stream entry.
  entry: unknown,
  fallbackIndex: number,
): ToolCallDelta | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted tool call delta entry.
  if (entry === null || typeof entry !== "object") return undefined;
  const obj = asUntrusted(entry);
  const id = field(obj, "id");
  const { name, argumentsDelta } = parseProviderToolCallFunction(field(obj, "function"));
  const delta: MutableToolCallDelta = { index: numberField(obj, "index") ?? fallbackIndex };
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted tool call id.
  if (typeof id === "string") delta.id = id;
  if (name !== undefined) delta.name = name;
  if (argumentsDelta !== undefined) delta.argumentsDelta = argumentsDelta;
  return delta satisfies ToolCallDelta;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the provider's own untrusted `tool_calls` field.
function parseProviderToolCallDeltas(toolCalls: unknown): ToolCallDelta[] {
  const deltas: ToolCallDelta[] = [];
  if (!Array.isArray(toolCalls)) return deltas;
  toolCalls.forEach(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: each array entry is still untrusted.
    (entry: unknown, idx: number) => {
      const delta = parseProviderToolCallDelta(entry, idx);
      if (delta !== undefined) deltas.push(delta);
    },
  );
  return deltas;
}

/**
 * Parse one decoded provider SSE data payload, tolerating both shapes this route sees on
 * `env.AI.run(model, { ..., stream: true })`: Workers AI's classic `{ response }` token events, and
 * chat-completion chunks, whose text and tool calls live in `choices[0].delta` while usage stays at
 * the top level. The deployed model streams the second shape.
 * Unrecognized fields are ignored rather than rejected — this seam degrades, it does not throw,
 * because a provider detail this route does not model must not fail an otherwise-good turn.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: this IS the parse boundary for the provider's own untrusted stream chunk.
export function parseProviderChunk(raw: unknown): ParsedProviderChunk | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted provider chunk.
  if (raw === null || typeof raw !== "object") return undefined;
  const obj = asUntrusted(raw);
  const delta = firstChoiceDelta(obj);

  const response = field(obj, "response");
  const content = delta === undefined ? undefined : field(delta, "content");
  const toolCalls =
    field(obj, "tool_calls") ?? (delta === undefined ? undefined : field(delta, "tool_calls"));
  const toolCallDeltas = parseProviderToolCallDeltas(toolCalls);
  const usage = parseProviderUsage(obj);

  const parsed: MutableParsedChunk = {};
  const text = stringField(response) ?? stringField(content);
  if (text !== undefined) parsed.textDelta = text;
  if (toolCallDeltas.length > 0) parsed.toolCallDeltas = toolCallDeltas;
  if (usage !== undefined) parsed.usage = usage;
  return parsed satisfies ParsedProviderChunk;
}
