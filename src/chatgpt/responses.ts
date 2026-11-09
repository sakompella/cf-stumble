import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ModelRouteRequest, RouteMessage } from "../model-route-wire/request.js";
import type { ProviderStreamAccumulator } from "../model-route-stream.js";
import { lenient } from "../lenient-schema.js";
import {
  ProviderErrorField,
  ProviderErrorFields,
  TokenCount,
  type TokenUsage,
} from "../model-route-stream-parse.js";
import type { ToolCallDelta } from "../model-route-wire/events.js";

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

const isString = Schema.is(Schema.String);

function safeCode(value: string | undefined): string {
  return value !== undefined && /^[\w.-]{1,80}$/u.test(value) ? value : "unknown";
}

export type ProviderError = Readonly<{ type: string; code: string }>;

const Item = Schema.Struct({
  type: lenient(Schema.String),
  call_id: lenient(Schema.String),
  name: lenient(Schema.String),
  arguments: lenient(Schema.String),
});

const ResponseFields = Schema.Struct({
  error: lenient(ProviderErrorFields),
  incomplete_details: lenient(Schema.Struct({ reason: lenient(Schema.String) })),
  usage: lenient(
    Schema.Struct({ input_tokens: lenient(TokenCount), output_tokens: lenient(TokenCount) }),
  ),
});

const StreamEventSchema = Schema.Struct({
  type: lenient(Schema.String),
  output_index: lenient(Schema.Number),
  delta: lenient(Schema.String),
  item: lenient(Item),
  response: lenient(ResponseFields),
  error: ProviderErrorField,
  code: lenient(Schema.String),
});

type StreamEvent = typeof StreamEventSchema.Type;

const decodeStreamEvent = Schema.decodeUnknownOption(Schema.fromJsonString(StreamEventSchema));

export const UNKNOWN_PROVIDER_ERROR: ProviderError = { type: "unknown", code: "unknown" };

function providerError(body: StreamEvent): ProviderError {
  const { response } = body;
  const nested = response?.error ?? (isString(body.error) ? undefined : body.error);
  const error = nested ?? body;

  return {
    type: safeCode(nested?.type),
    code: safeCode(error.code ?? response?.incomplete_details?.reason),
  };
}

export function providerErrorOfText(text: string): ProviderError {
  return decodeStreamEvent(text).pipe(
    Option.map((body) => providerError(body)),
    Option.getOrElse(() => UNKNOWN_PROVIDER_ERROR),
  );
}

const USAGE_LIMITS: ReadonlySet<string> = new Set([
  "subscription_sharing_usage_limit_exceeded",
  "subscription_sharing_workplace_individual_usage_limit_exceeded",
  "rate_limit_exceeded",
  "rate_limit_error",
  "insufficient_quota",
]);

export function isUsageLimit(status: number, error: ProviderError): boolean {
  return status === 429 || USAGE_LIMITS.has(error.code) || USAGE_LIMITS.has(error.type);
}

const MAX_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export function retryAt(header: string | null, now: number): number | null {
  if (header === null) return null;
  const text = header.trim();
  const at = /^\d+$/u.test(text) ? now + Number(text) * 1000 : Date.parse(text);

  return Number.isFinite(at) && at > now ? Math.min(at, now + MAX_RETRY_AFTER_MS) : null;
}

function usageOf(event: StreamEvent): TokenUsage | undefined {
  const inputTokens = event.response?.usage?.input_tokens;
  const outputTokens = event.response?.usage?.output_tokens;

  return inputTokens === undefined || outputTokens === undefined
    ? undefined
    : { inputTokens, outputTokens };
}

export class ResponsesStreamReader {
  private readonly accumulator: ProviderStreamAccumulator;
  failure: ProviderError | undefined;

  constructor(accumulator: ProviderStreamAccumulator) {
    this.accumulator = accumulator;
  }

  handleEvent(data: string): boolean {
    const event = decodeStreamEvent(data);

    return Option.isSome(event) && this.apply(event.value);
  }

  private apply(event: StreamEvent): boolean {
    const index = event.output_index ?? 0;

    switch (event.type ?? "") {
      case "response.output_text.delta":
      case "response.refusal.delta":
        if (event.delta !== undefined && event.delta !== "") {
          this.accumulator.apply({ textDelta: event.delta });
        }

        return false;
      case "response.output_item.added":
        this.functionCallStarted(index, event.item);

        return false;
      case "response.function_call_arguments.delta":
        if (event.delta !== undefined && event.delta !== "") {
          this.accumulator.apply({ toolCallDeltas: [{ index, argumentsDelta: event.delta }] });
        }

        return false;
      case "response.completed":
        this.accumulator.apply({ usage: usageOf(event) });

        return true;
      case "response.incomplete":
        if (event.response?.incomplete_details?.reason === "max_output_tokens") {
          this.accumulator.apply({ usage: usageOf(event), truncated: true });

          return true;
        }

        this.failure = providerError(event);

        return true;
      case "response.failed":
      case "error":
        this.failure = providerError(event);

        return true;
      default:
        if (event.error === undefined) return false;
        this.failure = providerError(event);

        return true;
    }
  }

  private functionCallStarted(index: number, item: typeof Item.Type | undefined): void {
    if (item?.type !== "function_call") return;

    const delta: ToolCallDelta = {
      index,
      id: item.call_id,
      name: item.name,
      argumentsDelta: item.arguments === "" ? undefined : item.arguments,
    };

    this.accumulator.apply({ toolCallDeltas: [delta] });
  }
}
