import { asUntrusted, field, isRecord, type UntrustedObject } from "./untrusted.js";
import type { ToolCallDelta } from "./model-route-events.js";

export type ParsedProviderChunk = Readonly<{
  textDelta?: string;
  toolCallDeltas?: ReadonlyArray<ToolCallDelta>;
  usage?: Readonly<{ inputTokens: number; outputTokens: number }>;
}>;

type MutableParsedChunk = {
  textDelta?: string;
  toolCallDeltas?: ToolCallDelta[];
  usage?: Readonly<{ inputTokens: number; outputTokens: number }>;
};

type ParsedToolCallFunction = Readonly<{ name?: string; argumentsDelta?: string }>;

type MutableToolCallFunction = { name?: string; argumentsDelta?: string };

type MutableToolCallDelta = { index: number; id?: string; name?: string; argumentsDelta?: string };

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: one untrusted provider field.
function stringField(value: unknown): string | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted provider field.
  return typeof value === "string" && value !== "" ? value : undefined;
}

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

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: one untrusted provider usage field.
export function tokenCount(value: unknown): number | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted provider usage field.
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseProviderUsage(obj: UntrustedObject): ParsedProviderChunk["usage"] {
  const usageValue = field(obj, "usage");

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted provider usage field.
  if (usageValue === null || typeof usageValue !== "object") return undefined;
  const usageObj = asUntrusted(usageValue);

  const inputTokens =
    tokenCount(field(usageObj, "prompt_tokens")) ?? tokenCount(field(usageObj, "input_tokens"));

  const outputTokens =
    tokenCount(field(usageObj, "completion_tokens")) ??
    tokenCount(field(usageObj, "output_tokens"));

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

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the provider's own untrusted stream event.
export function isProviderError(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const error = raw.error;

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: untrusted provider error field.
  return isRecord(error) || (typeof error === "string" && error !== "");
}

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
