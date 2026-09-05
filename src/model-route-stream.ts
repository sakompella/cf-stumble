/// <reference types="@cloudflare/workers-types" />

/**
 * The streaming half of the model route (E5, E7): drive one Workers AI streaming call, translate
 * its provider-native Server-Sent Events into this route's own plain `ModelStreamEvent` protocol
 * (`./model-route-stream-parse.ts` does the untrusted per-chunk parsing), and expose the two
 * public entry points `ModelRoute.runStream` and tests/fakes need.
 */

import { parseProviderChunk } from "./model-route-stream-parse.js";
import { MODEL, normalizeResponse } from "./model-route.js";
import type { ModelRouteRequest, ModelRouteResponse, ProviderResult } from "./model-route.js";
import type {
  ModelStreamEvent,
  ModelStreamInference,
  ModelUsage,
  StreamingProviderPayload,
  ToolCallDelta,
} from "./model-route-events.js";

function buildStreamingProviderPayload(request: ModelRouteRequest): StreamingProviderPayload {
  const tools = request.tools;
  return tools === undefined
    ? { messages: request.messages, reasoning_effort: "low", stream: true }
    : { messages: request.messages, tools, reasoning_effort: "low", stream: true };
}

/**
 * Call the Workers AI binding's overloaded `run` with a streaming payload. `model` here is a
 * plain string, not a literal key of the generated Workers AI model list, so TypeScript cannot
 * select `run`'s streaming overload (`Promise<ReadableStream>`) statically and instead types this
 * call through its untyped `Record<string, unknown>` fallback overload — even though
 * `input.stream: true` selects the real streaming behavior at runtime, which is what the real
 * binding returns for this input shape.
 */
export function streamingBindingCall(
  ai: Ai,
  model: string,
  input: StreamingProviderPayload,
): Promise<ReadableStream<Uint8Array>> {
  const raw: unknown = ai.run(model, input);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: see the function doc above.
  return raw as Promise<ReadableStream<Uint8Array>>;
}

/** Accumulated state for one tool call assembled across several `tool-call-delta` events. */
type ToolCallAccumulator = { id: string; name: string; args: string[] };

/**
 * Accumulates one turn's parsed provider chunks and emits the `ModelStreamEvent`s they imply.
 * Kept as a class so each step of the work stays a short, separately readable method.
 */
class ProviderStreamAccumulator {
  private readonly texts: string[] = [];
  private readonly toolCalls = new Map<number, ToolCallAccumulator>();
  private readonly emit: (event: ModelStreamEvent) => void;
  private reportedUsage: Readonly<{ inputTokens: number; outputTokens: number }> | undefined;

  constructor(emit: (event: ModelStreamEvent) => void) {
    this.emit = emit;
  }

  private applyToolCallDelta(delta: ToolCallDelta): void {
    const acc = this.toolCalls.get(delta.index) ?? { id: "", name: "", args: [] };
    if (delta.id !== undefined) acc.id = delta.id;
    if (delta.name !== undefined) acc.name = delta.name;
    if (delta.argumentsDelta !== undefined) acc.args.push(delta.argumentsDelta);
    this.toolCalls.set(delta.index, acc);
    this.emit({ type: "tool-call-delta", delta });
  }

  /** Parse and apply one decoded line; returns `true` when it is the terminal `[DONE]` marker. */
  handleLine(line: string): boolean {
    const trimmed = line.trim();
    if (trimmed === "" || !trimmed.startsWith("data:")) return false;
    const payload = trimmed.slice("data:".length).trim();
    if (payload === "[DONE]") return true;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(payload);
    } catch {
      return false;
    }
    const chunk = parseProviderChunk(parsedJson);
    if (chunk === undefined) return false;
    if (chunk.textDelta !== undefined) {
      this.texts.push(chunk.textDelta);
      this.emit({ type: "text-delta", delta: chunk.textDelta });
    }
    for (const delta of chunk.toolCallDeltas ?? []) this.applyToolCallDelta(delta);
    if (chunk.usage !== undefined) this.reportedUsage = chunk.usage;
    return false;
  }

  result(): ProviderResult {
    const response = this.texts.length > 0 ? this.texts.join("") : null;
    if (this.toolCalls.size === 0) return { response };
    return {
      response,
      tool_calls: Array.from(this.toolCalls.values()).map((acc) => ({
        id: acc.id,
        function: { name: acc.name, arguments: acc.args.join("") },
      })),
    };
  }

  usage(): Readonly<{ inputTokens: number; outputTokens: number }> | undefined {
    return this.reportedUsage;
  }
}

/**
 * Upper bound on the bytes this route will read from one provider stream. Applies to the
 * provider's raw wire bytes, not `JSON.stringify(...).length`, for the same reason
 * `validateRequest`'s request bound does: a byte cap stated in string length would not be a byte
 * cap. This is defense in depth against a runaway or misbehaving stream, not a measured provider
 * limit — generation 0 has none to report.
 */
const MAX_STREAM_EVENT_BYTES = 8_388_608;

/**
 * Decode one provider byte stream into lines and feed each to `onLine`, honoring split UTF-8
 * across chunk boundaries. Returns whether a terminal `[DONE]` marker was seen; a well-formed
 * provider owes one even in its very last chunk, which is why the final decoder flush gets one
 * more pass over `onLine` too.
 */
async function readSseLines(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onLine: (line: string) => boolean,
): Promise<boolean> {
  const decoder = new TextDecoder();
  let buffer = "";
  let totalBytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    totalBytes += next.value.byteLength;
    if (totalBytes > MAX_STREAM_EVENT_BYTES) {
      throw new Error("provider stream exceeded the event byte bound");
    }
    buffer += decoder.decode(next.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (onLine(line)) return true;
    }
  }
  buffer += decoder.decode();
  for (const line of buffer.split("\n")) {
    if (onLine(line)) return true;
  }
  return false;
}

/**
 * Read one provider SSE byte stream, emit a `ModelStreamEvent` per parsed chunk via `emit`, and
 * return the assembled `ProviderResult` plus any usage the provider reported. Throws when the
 * stream ends without a terminal `[DONE]` marker (a truncated provider stream) or exceeds the byte
 * bound; the caller turns either into a terminal `error` event rather than an uncaught rejection.
 */
async function pumpProviderStream(
  providerStream: ReadableStream<Uint8Array>,
  emit: (event: ModelStreamEvent) => void,
): Promise<
  Readonly<{
    result: ProviderResult;
    usage: Readonly<{ inputTokens: number; outputTokens: number }> | undefined;
  }>
> {
  const reader = providerStream.getReader();
  const accumulator = new ProviderStreamAccumulator(emit);
  let terminated: boolean;
  try {
    terminated = await readSseLines(reader, (line) => accumulator.handleLine(line));
  } finally {
    await reader.cancel().catch(() => {
      /* the stream already ended or failed; nothing more to release */
    });
  }
  if (!terminated) throw new Error("provider stream ended before a terminal marker");
  return { result: accumulator.result(), usage: accumulator.usage() };
}

const USAGE_BYTES = new TextEncoder();

/** Conservative bytes-per-token used only when the provider reports no usage of its own. */
const ESTIMATED_BYTES_PER_TOKEN = 3;

function estimateTokens(byteLength: number): number {
  return Math.ceil(byteLength / ESTIMATED_BYTES_PER_TOKEN);
}

function resolveUsage(
  reported: Readonly<{ inputTokens: number; outputTokens: number }> | undefined,
  request: ModelRouteRequest,
  result: ProviderResult,
): ModelUsage {
  if (reported !== undefined) {
    return {
      inputTokens: reported.inputTokens,
      outputTokens: reported.outputTokens,
      estimated: false,
    };
  }
  const promptBytes = USAGE_BYTES.encode(JSON.stringify(request.messages)).length;
  const completionBytes = USAGE_BYTES.encode(
    (result.response ?? "") + JSON.stringify(result.tool_calls ?? []),
  ).length;
  return {
    inputTokens: estimateTokens(promptBytes),
    outputTokens: estimateTokens(completionBytes),
    estimated: true,
  };
}

/**
 * Drive one streamed model call and translate it into plain {@link ModelStreamEvent}s. Every
 * outcome — a provider rejection, a truncated stream, or a clean finish — becomes an event on the
 * returned stream; nothing here throws across the RPC boundary or resolves a rejected promise.
 */
export function streamModelEvents(
  ai: ModelStreamInference,
  request: ModelRouteRequest,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      function emit(event: ModelStreamEvent): void {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }
      let providerStream: ReadableStream<Uint8Array>;
      try {
        providerStream = await ai.run(MODEL, buildStreamingProviderPayload(request));
      } catch {
        emit({ type: "error", error: { code: "model-unavailable" } });
        controller.close();
        return;
      }
      try {
        const { result, usage } = await pumpProviderStream(providerStream, emit);
        emit({
          type: "done",
          message: normalizeResponse(result),
          usage: resolveUsage(usage, request, result),
        });
      } catch {
        emit({ type: "error", error: { code: "model-unavailable" } });
      }
      controller.close();
    },
  });
}

const DEFAULT_ESTIMATED_USAGE: ModelUsage = { inputTokens: 0, outputTokens: 0, estimated: true };

/**
 * Encode one finished {@link ModelRouteResponse} as the single-event NDJSON stream
 * `ModelRoute.runStream` produces when a provider reports its entire reply in one chunk — the
 * behavior this route falls back to correctly if the real, unverified assumption that Workers AI
 * streams incremental deltas turns out false. Also lets a test or fake that already scripts a
 * buffered {@link ModelRouteResponse} produce the equivalent streaming shape without a live
 * provider.
 */
export function encodeModelRouteResponseAsStream(
  response: ModelRouteResponse,
  usage?: ModelUsage,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const event: ModelStreamEvent = response.ok
    ? { type: "done", message: response.message, usage: usage ?? DEFAULT_ESTIMATED_USAGE }
    : { type: "error", error: response.error };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      controller.close();
    },
  });
}
