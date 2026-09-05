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
 * Parse one decoded provider SSE data payload, tolerating either shape this route has reason to
 * expect on `env.AI.run(model, { ..., stream: true })`: Workers AI's classic `{ response }` token
 * events, and OpenAI-chat-completions-shaped `{ tool_calls: [...] }` / `{ usage: {...} }` chunks.
 * Unrecognized fields are ignored rather than rejected — this seam degrades, it does not throw,
 * because a provider detail this route does not model must not fail an otherwise-good turn.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: this IS the parse boundary for the provider's own untrusted stream chunk.
export function parseProviderChunk(raw: unknown): ParsedProviderChunk | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted provider chunk.
  if (raw === null || typeof raw !== "object") return undefined;
  const obj = asUntrusted(raw);

  const response = field(obj, "response");
  const toolCallDeltas = parseProviderToolCallDeltas(field(obj, "tool_calls"));
  const usage = parseProviderUsage(obj);

  const parsed: MutableParsedChunk = {};
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted response field.
  if (typeof response === "string" && response !== "") parsed.textDelta = response;
  if (toolCallDeltas.length > 0) parsed.toolCallDeltas = toolCallDeltas;
  if (usage !== undefined) parsed.usage = usage;
  return parsed satisfies ParsedProviderChunk;
}
