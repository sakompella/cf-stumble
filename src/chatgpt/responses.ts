// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- The Responses stream is the provider's own untrusted output, parsed at this boundary.

import type { ModelRouteRequest, RouteMessage } from "../model-route.js";
import type { ProviderStreamAccumulator } from "../model-route-stream.js";
import { isProviderError, tokenCount } from "../model-route-stream-parse.js";
import type { ToolCallDelta } from "../model-route-events.js";
import { asUntrusted, field, isRecord, type UntrustedObject } from "../untrusted.js";

/**
 * The OpenAI Responses API as the model route uses it with the owner's ChatGPT plan: one request
 * per model call, built from the route's closed message union, and a reader that turns the
 * streamed events into the chunks every provider's answer is assembled from.
 *
 * "Sign in with ChatGPT" requires `store: false` and `stream: true`, takes system text only as
 * `instructions`, and refuses `max_output_tokens` and `temperature`
 * (https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).
 */

export const RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";

const REASONING_EFFORT = "medium";

type InputItem =
  | Readonly<{ role: "user" | "assistant"; content: string }>
  | Readonly<{ type: "function_call"; call_id: string; name: string; arguments: string }>
  | Readonly<{ type: "function_call_output"; call_id: string; output: string }>;

type FunctionTool = Readonly<{
  type: "function";
  name: string;
  description: string;
  parameters: object;
  strict: false;
}>;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export type ResponsesRequestBody = Readonly<{
  model: string;
  instructions?: string;
  input: readonly InputItem[];
  tools?: readonly FunctionTool[];
  reasoning: Readonly<{ effort: typeof REASONING_EFFORT }>;
  store: false;
  stream: true;
}>;

function inputItems(message: RouteMessage): readonly InputItem[] {
  switch (message.role) {
    case "system":
      return [];
    case "user":
      return [{ role: "user", content: message.content }];
    case "assistant":
      return [
        ...(message.content === null || message.content === ""
          ? []
          : [{ role: "assistant", content: message.content } as const]),
        ...message.tool_calls.map(
          (call) =>
            ({
              type: "function_call",
              call_id: call.id,
              name: call.function.name,
              arguments: call.function.arguments,
            }) as const,
        ),
      ];
    case "tool":
      return [
        { type: "function_call_output", call_id: message.tool_call_id, output: message.content },
      ];
    default: {
      const exhaustive: never = message;

      return exhaustive;
    }
  }
}

export function responsesRequest(model: string, request: ModelRouteRequest): ResponsesRequestBody {
  const body: Mutable<ResponsesRequestBody> = {
    model,
    input: request.messages.flatMap((message) => inputItems(message)),
    reasoning: { effort: REASONING_EFFORT },
    store: false,
    stream: true,
  };

  const instructions = request.messages
    .flatMap((message) => (message.role === "system" ? [message.content] : []))
    .join("\n\n");

  if (instructions !== "") body.instructions = instructions;

  if (request.tools !== undefined && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
      strict: false,
    }));
  }

  return body;
}

/** A provider error code as a log field: short and plain, or `unknown`. */
export function safeCode(value: unknown): string {
  return typeof value === "string" && /^[\w.-]{1,80}$/u.test(value) ? value : "unknown";
}

function objectAt(value: unknown, key: string): UntrustedObject | undefined {
  const found = isRecord(value) ? field(asUntrusted(value), key) : undefined;

  return isRecord(found) ? asUntrusted(found) : undefined;
}

function stringAt(value: unknown, key: string): string | undefined {
  const found = isRecord(value) ? field(asUntrusted(value), key) : undefined;

  return typeof found === "string" ? found : undefined;
}

function numberAt(value: unknown, key: string): number | undefined {
  const found = isRecord(value) ? field(asUntrusted(value), key) : undefined;

  return typeof found === "number" ? found : undefined;
}

function usageOf(
  event: UntrustedObject,
): Readonly<{ inputTokens: number; outputTokens: number }> | undefined {
  const usage = objectAt(objectAt(event, "response"), "usage");
  const inputTokens = tokenCount(numberAt(usage, "input_tokens"));
  const outputTokens = tokenCount(numberAt(usage, "output_tokens"));

  return inputTokens === undefined || outputTokens === undefined
    ? undefined
    : { inputTokens, outputTokens };
}

/**
 * Why a stream ended without `response.completed`: the provider's error code, the reason a
 * response was incomplete, or `unknown`.
 */
function failureCode(event: UntrustedObject): string {
  const response = objectAt(event, "response");
  const error = objectAt(response, "error") ?? objectAt(event, "error") ?? event;

  return safeCode(
    stringAt(error, "code") ?? stringAt(objectAt(response, "incomplete_details"), "reason"),
  );
}

/**
 * Reads one Responses event stream into an accumulator. Text deltas and function call fragments
 * become chunks as they arrive; `response.completed` ends the stream with the provider's usage, and
 * `response.failed`, `response.incomplete`, `error`, or an untyped `{"error": ...}` object ends it
 * with {@link failure} set. A call's
 * `output_index` is its slot, so a reasoning item before it leaves a gap rather than a merge.
 */
export class ResponsesStreamReader {
  private readonly accumulator: ProviderStreamAccumulator;
  /** Set when the stream ended without a completed response. */
  failure: string | undefined;

  constructor(accumulator: ProviderStreamAccumulator) {
    this.accumulator = accumulator;
  }

  /** Apply one decoded SSE line; returns `true` at the terminal event. */
  handleLine(line: string): boolean {
    const trimmed = line.trim();

    if (!trimmed.startsWith("data:")) return false;
    let event: unknown;

    try {
      event = JSON.parse(trimmed.slice("data:".length).trim());
    } catch {
      return false;
    }

    return isRecord(event) && this.apply(asUntrusted(event));
  }

  private apply(event: UntrustedObject): boolean {
    const index = numberAt(event, "output_index") ?? 0;

    switch (field(event, "type")) {
      case "response.output_text.delta": {
        const delta = stringAt(event, "delta");

        if (delta !== undefined && delta !== "") this.accumulator.apply({ textDelta: delta });

        return false;
      }

      case "response.output_item.added":
        this.functionCallStarted(index, objectAt(event, "item"));

        return false;
      case "response.function_call_arguments.delta": {
        const argumentsDelta = stringAt(event, "delta");

        if (argumentsDelta !== undefined && argumentsDelta !== "") {
          this.accumulator.apply({ toolCallDeltas: [{ index, argumentsDelta }] });
        }

        return false;
      }

      case "response.completed": {
        const usage = usageOf(event);

        if (usage !== undefined) this.accumulator.apply({ usage });

        return true;
      }

      case "response.failed":
      case "response.incomplete":
      case "error":
        this.failure = failureCode(event);

        return true;
      default:
        if (!isProviderError(event)) return false;
        this.failure = failureCode(event);

        return true;
    }
  }

  private functionCallStarted(index: number, item: UntrustedObject | undefined): void {
    if (stringAt(item, "type") !== "function_call") return;

    const delta: Mutable<ToolCallDelta> = { index };
    const id = stringAt(item, "call_id");
    const name = stringAt(item, "name");
    const argumentsDelta = stringAt(item, "arguments");

    if (id !== undefined) delta.id = id;

    if (name !== undefined) delta.name = name;

    if (argumentsDelta !== undefined && argumentsDelta !== "")
      delta.argumentsDelta = argumentsDelta;

    this.accumulator.apply({ toolCallDeltas: [delta] });
  }
}
