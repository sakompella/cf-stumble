import type { AssistantMessage, RouteMessage, ToolDefinition } from "./model-route.js";

/**
 * `stream: true` selects the Workers AI binding's streaming overload, which returns a
 * `Promise<ReadableStream>` of provider-native SSE.
 */
export type StreamingProviderPayload = Readonly<{
  messages: ReadonlyArray<RouteMessage>;
  tools?: ReadonlyArray<ToolDefinition>;
  reasoning_effort: "low";
  max_tokens: number;
  stream: true;
}>;

/** `signal` aborts once nobody reads the route's stream any more. */
export type ModelStreamInference = {
  run(
    model: string,
    input: StreamingProviderPayload,
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>>;
};

/**
 * `index` is the provider's slot for a tool call within a turn (parallel calls interleave);
 * `argumentsDelta` is a fragment to append.
 */
export type ToolCallDelta = Readonly<{
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}>;

/**
 * `estimated: true` marks a byte-derived guess because the provider reported none, not zero tokens.
 */
export type ModelUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
}>;

/** Plain data only, so the RPC envelope stays plain across the Worker boundary. */
export type ModelStreamEvent =
  | Readonly<{ type: "text-delta"; delta: string }>
  | Readonly<{ type: "tool-call-delta"; delta: ToolCallDelta }>
  | Readonly<{ type: "done"; message: AssistantMessage; usage: ModelUsage }>
  | Readonly<{ type: "error"; error: Readonly<{ code: ModelRouteErrorCode }> }>
  | ProviderFallback;

/** `limitedUntil` is when the route asks ChatGPT again, or `null` when OpenAI named no end. */
export type ProviderFallback = Readonly<{
  type: "provider-fallback";
  reason: "chatgpt-usage-limit";
  limitedUntil: number | null;
}>;

/**
 * `chatgpt-reconnect-required`: the grant was refused or revoked. Every turn fails this way, with
 * no answer from another provider, until reconnect or disconnect.
 */
export type ModelRouteErrorCode = "model-unavailable" | "chatgpt-reconnect-required";
