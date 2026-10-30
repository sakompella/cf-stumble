import * as Effect from "effect/Effect";
import {
  isProviderError,
  parseProviderChunk,
  type ParsedProviderChunk,
} from "./model-route-stream-parse.js";
import type { AssistantMessage, ModelRouteRequest, ToolCall } from "./model-route.js";
import type {
  ModelStreamEvent,
  ModelStreamInference,
  StreamingProviderPayload,
  ToolCallDelta,
} from "./model-route-events.js";
import { resolveUsage, type ProviderResult } from "./model-route-usage.js";
import {
  modelEventStream,
  modelUnavailable,
  pumpSseStream,
  type ModelTurn,
  type ModelTurnAnswer,
} from "./model-route-turn.js";

// This model answers in `reasoning_content`, which spends the default output budget, hence
// `MAX_OUTPUT_TOKENS`.
// Llama 3.3 rejects Pi's content parts: its schema takes `messages[].content` as a string.
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
 * `model` is a plain string, so TypeScript picks `run`'s untyped fallback overload; `stream: true`
 * still selects streaming at runtime.
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

type ToolCallAccumulator = { id: string; name: string; args: string[] };

export class ProviderStreamAccumulator {
  private readonly texts: string[] = [];
  private readonly toolCalls = new Map<number, ToolCallAccumulator>();
  private readonly emit: (event: ModelStreamEvent) => void;
  private reportedUsage: Readonly<{ inputTokens: number; outputTokens: number }> | undefined;
  providerFailed = false;

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

    if (isProviderError(parsedJson)) {
      this.providerFailed = true;

      return true;
    }

    const chunk = parseProviderChunk(parsedJson);

    if (chunk !== undefined) this.apply(chunk);

    return false;
  }

  apply(chunk: ParsedProviderChunk): void {
    if (chunk.textDelta !== undefined) {
      this.texts.push(chunk.textDelta);
      this.emit({ type: "text-delta", delta: chunk.textDelta });
    }

    for (const delta of chunk.toolCallDeltas ?? []) this.applyToolCallDelta(delta);

    if (chunk.usage !== undefined) this.reportedUsage = chunk.usage;
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

export function finishedTurn(
  accumulator: ProviderStreamAccumulator,
  request: ModelRouteRequest,
): ModelTurnAnswer {
  const result = accumulator.result();

  return {
    message: normalizeResponse(result),
    usage: resolveUsage(accumulator.usage(), request, result),
  };
}

export function workersAiTurn(ai: ModelStreamInference, request: ModelRouteRequest): ModelTurn {
  return (emit) => {
    const accumulator = new ProviderStreamAccumulator(emit);

    return Effect.tryPromise({
      try: (signal) => ai.run(MODEL, buildStreamingProviderPayload(request), signal),
      catch: modelUnavailable,
    }).pipe(
      Effect.flatMap((providerStream) =>
        pumpSseStream(providerStream, (line) => accumulator.handleLine(line)),
      ),
      Effect.flatMap(() =>
        accumulator.providerFailed
          ? Effect.fail(modelUnavailable())
          : Effect.succeed(finishedTurn(accumulator, request)),
      ),
    );
  };
}

export function streamModelEvents(
  ai: ModelStreamInference,
  request: ModelRouteRequest,
): ReadableStream<Uint8Array> {
  return modelEventStream(workersAiTurn(ai, request));
}
