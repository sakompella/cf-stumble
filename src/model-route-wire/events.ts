import {
  arr,
  bool,
  compile,
  lit,
  nul,
  num,
  obj,
  oneOf,
  opt,
  str,
  union,
} from "@earendil-works/pi-schema";
import type { AssistantMessage, RouteMessage, ToolDefinition } from "./request.js";

export const MAX_STREAM_EVENT_BYTES = 8_388_608;

export type StreamingProviderPayload = Readonly<{
  messages: ReadonlyArray<RouteMessage>;
  tools?: ReadonlyArray<ToolDefinition>;
  reasoning_effort: "low";
  max_tokens: number;
  stream: true;
}>;

export type ModelStreamInference = {
  run(
    model: string,
    input: StreamingProviderPayload,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>>;
};

export type ToolCallDelta = Readonly<{
  index: number;
  id?: string | undefined;
  name?: string | undefined;
  argumentsDelta?: string | undefined;
}>;

export type WorkersAiBinding = {
  run(
    model: string,
    input: StreamingProviderPayload,
    options: { signal: AbortSignal; extraHeaders: Record<string, string> },
  ): Promise<ReadableStream<Uint8Array>>;
};

export type ModelUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
}>;

export type ModelStreamEvent =
  | Readonly<{ type: "text-delta"; delta: string }>
  | Readonly<{ type: "tool-call-delta"; delta: ToolCallDelta }>
  | Readonly<{ type: "done"; message: AssistantMessage; usage: ModelUsage; truncated?: true }>
  | Readonly<{ type: "error"; error: Readonly<{ code: ModelRouteErrorCode; detail?: string }> }>
  | ProviderFallback;

type ProviderFallback = Readonly<{
  type: "provider-fallback";
  reason: "chatgpt-usage-limit";
  limitedUntil: number | null;
}>;

export type ModelRouteErrorCode = "model-unavailable" | "chatgpt-reconnect-required";

const ToolCallDeltaSchema = obj(
  {
    index: num(),
    id: opt(str()),
    name: opt(str()),
    argumentsDelta: opt(str()),
  },
  { open: true },
);

const ToolCallSchema = obj(
  {
    id: str(),
    function: obj({ name: str(), arguments: str() }, { open: true }),
  },
  { open: true },
);

const AssistantMessageSchema = obj(
  {
    role: lit("assistant"),
    content: union([str(), nul()]),
    tool_calls: arr(ToolCallSchema),
  },
  { open: true },
);

const UsageSchema = obj(
  { inputTokens: num(), outputTokens: num(), estimated: bool() },
  { open: true },
);

const ModelStreamEventSchema = union([
  obj({ type: lit("text-delta"), delta: str() }, { open: true }),
  obj({ type: lit("tool-call-delta"), delta: ToolCallDeltaSchema }, { open: true }),
  obj(
    {
      type: lit("done"),
      message: AssistantMessageSchema,
      usage: UsageSchema,
      truncated: opt(lit(true)),
    },
    { open: true },
  ),
  obj(
    {
      type: lit("error"),
      error: obj(
        { code: oneOf(["model-unavailable", "chatgpt-reconnect-required"]), detail: opt(str()) },
        { open: true },
      ),
    },
    { open: true },
  ),
  obj(
    {
      type: lit("provider-fallback"),
      reason: lit("chatgpt-usage-limit"),
      limitedUntil: union([num(), nul()]),
    },
    { open: true },
  ),
]);

const checkModelStreamEvent = compile(ModelStreamEventSchema).check;

export function isModelStreamEvent(value: unknown): value is ModelStreamEvent {
  return checkModelStreamEvent(value);
}
