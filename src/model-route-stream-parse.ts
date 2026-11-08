import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { lenient } from "./lenient-schema.js";
import type { ToolCallDelta } from "./model-route-wire/events.js";

export const TokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ProviderErrorFields = Schema.Struct({
  type: lenient(Schema.String),
  code: lenient(Schema.String),
});

export const ProviderErrorField = lenient(
  Schema.Union([ProviderErrorFields, Schema.NonEmptyString]),
);

const isString = Schema.is(Schema.String);

export type TokenUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number | undefined;
}>;

export type ParsedProviderChunk = Readonly<{
  textDelta?: string | undefined;
  toolCallDeltas?: ReadonlyArray<ToolCallDelta> | undefined;
  usage?: TokenUsage | undefined;
  truncated?: true | undefined;
}>;

export type ProviderPayload =
  | Readonly<{ failed: true; detail: string | undefined }>
  | Readonly<{ failed: false; chunk: ParsedProviderChunk }>;

const ToolCallEntry = Schema.Struct({
  index: lenient(Schema.Number),
  id: lenient(Schema.String),
  function: lenient(
    Schema.Struct({ name: lenient(Schema.String), arguments: lenient(Schema.String) }),
  ),
});

const Entries = Schema.Array(Schema.Unknown);

const Delta = Schema.Struct({
  content: lenient(Schema.NonEmptyString),
  tool_calls: lenient(Entries),
});

const Choice = Schema.Struct({ delta: lenient(Delta), finish_reason: lenient(Schema.String) });

const Usage = Schema.Struct({
  prompt_tokens: lenient(TokenCount),
  input_tokens: lenient(TokenCount),
  completion_tokens: lenient(TokenCount),
  output_tokens: lenient(TokenCount),
  prompt_tokens_details: lenient(Schema.Struct({ cached_tokens: lenient(TokenCount) })),
});

const ProviderEventSchema = Schema.Struct({
  error: ProviderErrorField,
  response: lenient(Schema.NonEmptyString),
  tool_calls: lenient(Entries),
  choices: lenient(Entries),
  usage: lenient(Usage),
});

type ProviderEvent = typeof ProviderEventSchema.Type;

const decodeProviderEvent = Schema.decodeUnknownOption(Schema.fromJsonString(ProviderEventSchema));

const decodeChoice = Schema.decodeUnknownOption(Choice);

const decodeToolCall = Schema.decodeUnknownOption(ToolCallEntry);

function firstChoice(event: ProviderEvent): typeof Choice.Type | undefined {
  const choice = event.choices?.at(0);

  return choice === undefined ? undefined : Option.getOrUndefined(decodeChoice(choice));
}

function firstDelta(event: ProviderEvent): typeof Delta.Type | undefined {
  return firstChoice(event)?.delta;
}

function toolCallDeltas(event: ProviderEvent): ToolCallDelta[] {
  const entries = event.tool_calls ?? firstDelta(event)?.tool_calls ?? [];

  return entries.flatMap((entry, position) =>
    decodeToolCall(entry).pipe(
      Option.map((call): ToolCallDelta => ({
        index: call.index ?? position,
        id: call.id,
        name: call.function?.name,
        argumentsDelta: call.function?.arguments,
      })),
      Option.toArray,
    ),
  );
}

function usageOf(event: ProviderEvent): TokenUsage | undefined {
  const inputTokens = event.usage?.prompt_tokens ?? event.usage?.input_tokens;
  const outputTokens = event.usage?.completion_tokens ?? event.usage?.output_tokens;

  return inputTokens === undefined || outputTokens === undefined
    ? undefined
    : {
        inputTokens,
        outputTokens,
        cachedTokens: event.usage?.prompt_tokens_details?.cached_tokens,
      };
}

function chunkOf(event: ProviderEvent): ParsedProviderChunk {
  const deltas = toolCallDeltas(event);

  return {
    textDelta: event.response ?? firstDelta(event)?.content,
    toolCallDeltas: deltas.length > 0 ? deltas : undefined,
    usage: usageOf(event),
    truncated: firstChoice(event)?.finish_reason === "length" ? true : undefined,
  };
}

function errorDetail(error: NonNullable<ProviderEvent["error"]>): string | undefined {
  return isString(error) ? error : (error.code ?? error.type);
}

export function parseProviderPayload(payload: string): ProviderPayload | undefined {
  return decodeProviderEvent(payload).pipe(
    Option.map((event): ProviderPayload =>
      event.error === undefined
        ? { failed: false, chunk: chunkOf(event) }
        : { failed: true, detail: errorDetail(event.error) },
    ),
    Option.getOrUndefined,
  );
}
