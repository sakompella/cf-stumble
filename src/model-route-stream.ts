/**
 * The streaming half of the model route: build the payload for the one fixed model, drive one
 * Workers AI streaming call, and translate its provider-native Server-Sent Events into the plain
 * `ModelStreamEvent` protocol that `ModelRoute.runStream` returns. `./model-route-stream-parse.ts`
 * does the untrusted per-chunk parsing.
 */

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { parseProviderChunk } from "./model-route-stream-parse.js";
import type { AssistantMessage, ModelRouteRequest, ToolCall } from "./model-route.js";
import type {
  ModelStreamEvent,
  ModelStreamInference,
  StreamingProviderPayload,
  ToolCallDelta,
} from "./model-route-events.js";
import { resolveUsage, type ProviderResult } from "./model-route-usage.js";
import { runResponseBody } from "./run-entry-point.js";
import { KEEPALIVE_LINE, keptAlive } from "./stream-keepalive.js";

// The only model the immutable host selects. Two deployed facts pin it. Turns first saved an empty
// assistant message, because this model answers in `reasoning_content` and the default output
// budget was spent there, hence `MAX_OUTPUT_TOKENS`. `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
// then failed every call: its schema takes `messages[].content` as a string, and Pi sends parts.
const MODEL = "@cf/zai-org/glm-5.3-flash" as const;

const REASONING_EFFORT = "low" as const;

const MAX_OUTPUT_TOKENS = 4096;

function buildStreamingProviderPayload(request: ModelRouteRequest): StreamingProviderPayload {
  const fixed = {
    reasoning_effort: REASONING_EFFORT,
    max_tokens: MAX_OUTPUT_TOKENS,
    stream: true,
  } as const;

  return request.tools === undefined
    ? { messages: request.messages, ...fixed }
    : { messages: request.messages, tools: request.tools, ...fixed };
}

export function normalizeResponse(raw: ProviderResult): AssistantMessage {
  const content = raw.response ?? null;
  const toolCalls: ToolCall[] = [];

  if (raw.tool_calls !== undefined) {
    for (const tc of raw.tool_calls) {
      toolCalls.push({
        id: tc.id,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      });
    }
  }

  return { role: "assistant", content, tool_calls: toolCalls };
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
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const raw: unknown = ai.run(model, input, { signal });

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
 * The provider did not give this turn a complete answer: the binding call failed, the stream
 * failed or ended before its terminal `[DONE]` marker, or it passed the byte bound. The caller sees
 * one `model-unavailable` event for every one of these, and nothing of the provider's own error.
 */
class ModelUnavailable extends Data.TaggedError("ModelUnavailable") {}

type PumpedProviderStream = Readonly<{
  result: ProviderResult;
  usage: Readonly<{ inputTokens: number; outputTokens: number }> | undefined;
}>;

/**
 * Read one provider SSE byte stream, emit a `ModelStreamEvent` per parsed chunk via `emit`, and
 * return the assembled `ProviderResult` plus any usage the provider reported. The reader is
 * cancelled however the read ends, so a stream this route stopped reading is released.
 */
function pumpProviderStream(
  providerStream: ReadableStream<Uint8Array>,
  emit: (event: ModelStreamEvent) => void,
): Effect.Effect<PumpedProviderStream, ModelUnavailable> {
  const accumulator = new ProviderStreamAccumulator(emit);

  return Effect.acquireUseRelease(
    Effect.try({
      try: () => providerStream.getReader(),
      catch: () => new ModelUnavailable(),
    }),
    (reader) =>
      Effect.tryPromise({
        try: () => readSseLines(reader, (line) => accumulator.handleLine(line)),
        catch: () => new ModelUnavailable(),
      }),
    (reader) =>
      Effect.promise(() =>
        reader.cancel().catch(() => {
          /* the stream already ended or failed; nothing more to release */
        }),
      ),
  ).pipe(
    Effect.flatMap((terminated) =>
      terminated
        ? Effect.succeed({ result: accumulator.result(), usage: accumulator.usage() })
        : Effect.fail(new ModelUnavailable()),
    ),
  );
}

/** One model call, reported as events: its deltas, then `done` or `model-unavailable`. */
function modelAnswer(
  ai: ModelStreamInference,
  request: ModelRouteRequest,
  emit: (event: ModelStreamEvent) => void,
): Effect.Effect<void> {
  return Effect.tryPromise({
    try: (signal) => ai.run(MODEL, buildStreamingProviderPayload(request), signal),
    catch: () => new ModelUnavailable(),
  }).pipe(
    Effect.flatMap((providerStream) => pumpProviderStream(providerStream, emit)),
    Effect.flatMap(({ result, usage }) =>
      Effect.sync(() => {
        emit({
          type: "done",
          message: normalizeResponse(result),
          usage: resolveUsage(usage, request, result),
        });
      }),
    ),
    Effect.catchTag("ModelUnavailable", () =>
      Effect.sync(() => {
        emit({ type: "error", error: { code: "model-unavailable" } });
      }),
    ),
  );
}

/**
 * Drive one streamed model call and translate it into plain {@link ModelStreamEvent}s. Every
 * outcome — a provider rejection, a truncated stream, or a clean finish — becomes an event on the
 * returned stream; nothing here throws across the RPC boundary or resolves a rejected promise.
 *
 * The call runs in the stream's own `start`, so its lifetime is the body's, not the RPC call's
 * that returned the stream. Cancelling the stream interrupts the call, which aborts the provider
 * request or cancels its stream. While the provider is quiet the stream writes empty lines, so a
 * generation that stops reading across Workers RPC is heard of within seconds.
 */
export function streamModelEvents(
  ai: ModelStreamInference,
  request: ModelRouteRequest,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const cancelled = new AbortController();
  let ended: Promise<void> | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      function write(bytes: Uint8Array): void {
        if (!cancelled.signal.aborted) controller.enqueue(bytes);
      }

      function emit(event: ModelStreamEvent): void {
        write(encoder.encode(`${JSON.stringify(event)}\n`));
      }

      const turn = keptAlive(modelAnswer(ai, request, emit), () => {
        write(KEEPALIVE_LINE);
      }).pipe(
        Effect.andThen(
          Effect.sync(() => {
            controller.close();
          }),
        ),
      );

      ended = runResponseBody(turn, cancelled.signal);

      return ended;
    },
    cancel() {
      cancelled.abort();

      return ended?.then(
        () => {},
        () => {},
      );
    },
  });
}
