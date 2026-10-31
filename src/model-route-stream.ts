import * as Effect from "effect/Effect";
import {
  parseProviderPayload,
  type ParsedProviderChunk,
  type TokenUsage,
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
  modelUnavailable,
  pumpSseStream,
  type ModelTurn,
  type ModelTurnAnswer,
} from "./model-route-turn.js";

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

function normalizeResponse(raw: ProviderResult): AssistantMessage {
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

type ToolCallAccumulator = { id: string; name: string; args: string[] };

export class ProviderStreamAccumulator {
  private readonly texts: string[] = [];
  private readonly toolCalls = new Map<number, ToolCallAccumulator>();
  private readonly emit: (event: ModelStreamEvent) => void;
  private reportedUsage: TokenUsage | undefined;
  providerFailed = false;
  truncated = false;

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
    const parsed = parseProviderPayload(payload);

    if (parsed === undefined) return false;

    if (parsed.failed) {
      this.providerFailed = true;

      return true;
    }

    this.apply(parsed.chunk);

    return false;
  }

  apply(chunk: ParsedProviderChunk): void {
    if (chunk.textDelta !== undefined) {
      this.texts.push(chunk.textDelta);
      this.emit({ type: "text-delta", delta: chunk.textDelta });
    }

    for (const delta of chunk.toolCallDeltas ?? []) this.applyToolCallDelta(delta);

    if (chunk.usage !== undefined) this.reportedUsage = chunk.usage;

    if (chunk.truncated !== undefined) this.truncated = true;
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

  usage(): TokenUsage | undefined {
    return this.reportedUsage;
  }
}

export function finishedTurn(
  accumulator: ProviderStreamAccumulator,
  request: ModelRouteRequest,
): ModelTurnAnswer {
  const result = accumulator.result();

  const answer = {
    message: normalizeResponse(result),
    usage: resolveUsage(accumulator.usage(), request, result),
  };

  return accumulator.truncated ? { ...answer, truncated: true } : answer;
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
