/**
 * Plain, JSON-serializable types for one streamed model call (E5, E7): the payload shape that
 * selects Workers AI's streaming behavior, the capability a streaming call needs from the
 * binding, and the events this route emits while it drives one. Kept separate from
 * `model-route.ts` so that file's request/response/validation types stay the ones most readers
 * come here for.
 */

import type { AssistantMessage, ProviderPayload } from "./model-route.js";

/**
 * The same fixed-model, fixed-reasoning payload `ProviderPayload` builds, with the one extra
 * field the Workers AI binding's TypeScript overloads key their streaming return type on: passing
 * `stream: true` on the input is what turns `Ai.run`'s return type from a buffered object into a
 * `Promise<ReadableStream>` of provider-native Server-Sent Events.
 */
export type StreamingProviderPayload = ProviderPayload & Readonly<{ stream: true }>;

/**
 * The capability a streaming call needs from the Workers AI binding: pass the fixed model and a
 * streaming payload, get back the raw provider byte stream. This mirrors `Ai.run(model, { ...,
 * stream: true })`'s real return type so a fake in tests and the real `env.AI` binding satisfy the
 * same shape.
 */
export type ModelStreamInference = {
  run(model: string, input: StreamingProviderPayload): Promise<ReadableStream<Uint8Array>>;
};

/**
 * One fragment of a tool call assembled across several provider stream chunks. `index` is the
 * provider's own slot number for a tool call within one assistant turn (parallel tool calls stream
 * interleaved by index); `id` and `name` typically arrive once on the first chunk for that index,
 * while `argumentsDelta` is a fragment of the arguments JSON text to append, not a replacement.
 */
export type ToolCallDelta = Readonly<{
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}>;

/**
 * Token counts for one turn. `estimated: true` marks a conservative byte-derived guess this route
 * made because the provider reported none — never a claim that zero tokens were used.
 */
export type ModelUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
}>;

/**
 * The plain, JSON-serializable events this route emits for one streamed turn. Every event is one
 * NDJSON line inside the `ReadableStream<Uint8Array>` `ModelRoute.runStream` returns, which is what
 * keeps the RPC envelope plain across the Worker boundary (ADR-0035): nothing here is a class
 * instance, only data the caller's own isolate parses.
 */
export type ModelStreamEvent =
  | Readonly<{ type: "text-delta"; delta: string }>
  | Readonly<{ type: "tool-call-delta"; delta: ToolCallDelta }>
  | Readonly<{ type: "done"; message: AssistantMessage; usage: ModelUsage }>
  | Readonly<{ type: "error"; error: Readonly<{ code: "model-unavailable" }> }>;
