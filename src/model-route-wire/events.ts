import type { AssistantMessage, RouteMessage, ToolDefinition } from "./request.js";

export const MAX_STREAM_EVENT_BYTES = 8_388_608;

export const MAX_OUTPUT_TOKENS = 32_768;

export const REASONING_EFFORT = "low";

export type ProviderMessage =
  | Exclude<RouteMessage, AssistantMessage>
  | (Omit<AssistantMessage, "tool_calls"> &
      Readonly<{
        tool_calls: ReadonlyArray<AssistantMessage["tool_calls"][number] & { type: "function" }>;
      }>);

export type StreamingProviderPayload = Readonly<{
  messages: ReadonlyArray<ProviderMessage>;
  tools?: ReadonlyArray<ToolDefinition>;
  reasoning_effort: typeof REASONING_EFFORT;
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
  cachedTokens?: number | undefined;
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
