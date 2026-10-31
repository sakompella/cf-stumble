import type { AssistantMessage, RouteMessage, ToolDefinition } from "./model-route.js";

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
    options: { signal: AbortSignal },
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
  | Readonly<{ type: "done"; message: AssistantMessage; usage: ModelUsage }>
  | Readonly<{ type: "error"; error: Readonly<{ code: ModelRouteErrorCode }> }>
  | ProviderFallback;

type ProviderFallback = Readonly<{
  type: "provider-fallback";
  reason: "chatgpt-usage-limit";
  limitedUntil: number | null;
}>;

export type ModelRouteErrorCode = "model-unavailable" | "chatgpt-reconnect-required";

const EVENT_TYPES: ReadonlySet<string> = new Set<ModelStreamEvent["type"]>([
  "text-delta",
  "tool-call-delta",
  "done",
  "error",
  "provider-fallback",
]);

export function isModelStreamEvent(value: unknown): value is ModelStreamEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string" &&
    EVENT_TYPES.has(value.type)
  );
}
