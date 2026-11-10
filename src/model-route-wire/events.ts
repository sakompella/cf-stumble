import type { AssistantMessage, RouteMessage, ToolDefinition } from "./request.js";

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
