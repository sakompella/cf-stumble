import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const MAX_REQUEST_BYTES = 1_048_576;

const REQUEST_BYTES = new TextEncoder();

const FORBIDDEN_FIELDS: readonly string[] = [
  "model",
  "reasoning_effort",
  "credentials",
  "endpoint",
  "provider",
];

const FieldsSchema = Schema.Record(Schema.String, Schema.Unknown);

type Fields = typeof FieldsSchema.Type;

const isFields = Schema.is(FieldsSchema);

const EntriesSchema = Schema.Array(Schema.Unknown);

const isEntries = Schema.is(EntriesSchema);

const ToolCallSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  function: Schema.Struct({ name: Schema.NonEmptyString, arguments: Schema.String }),
});

const AssistantMessageSchema = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.NullOr(Schema.String),
  tool_calls: Schema.Array(ToolCallSchema).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});

const RouteMessageSchema = Schema.Union([
  Schema.Struct({ role: Schema.Literal("system"), content: Schema.String }),
  Schema.Struct({ role: Schema.Literal("user"), content: Schema.String }),
  AssistantMessageSchema,
  Schema.Struct({
    role: Schema.Literal("tool"),
    tool_call_id: Schema.NonEmptyString,
    content: Schema.String,
  }),
]);

const ToolDefinitionSchema = Schema.Struct({
  type: Schema.Literal("function"),
  function: Schema.Struct({
    name: Schema.NonEmptyString,
    description: Schema.String,
    parameters: Schema.declare<object>(isFields),
  }),
});

const RequestSchema = Schema.Struct({
  messages: Schema.Array(RouteMessageSchema),
  tools: Schema.optionalKey(Schema.Array(ToolDefinitionSchema)),
});

export type AssistantMessage = typeof AssistantMessageSchema.Type;

export type RouteMessage = typeof RouteMessageSchema.Type;

export type ToolDefinition = typeof ToolDefinitionSchema.Type;

export type ModelRouteRequest = typeof RequestSchema.Type;

export type ValidationFailure = Readonly<{
  ok: false;
  error: Readonly<{ code: "invalid-request"; reason: string }>;
}>;

export type RouteWire = ModelRouteRequest | Schema.Json;

type Parsed<T> = Result.Result<T, string>;

const decodeRequest = Schema.decodeUnknownResult(RequestSchema);

const AT_PATH = /\n  at (.+)$/u;

const QUOTED_KEY = /\["([^"]+)"\]/gu;

function wirePath(at: string): string {
  return at.replaceAll(QUOTED_KEY, ".$1").replace(/^\./u, "");
}

function decodeReason(failure: Schema.SchemaError): string {
  return failure.message.replace(AT_PATH, (_all, at: string) => ` at ${wirePath(at)}`);
}

function wireBytes(raw: Fields): Result.Result<number, string> {
  try {
    return Result.succeed(REQUEST_BYTES.encode(JSON.stringify(raw)).length);
  } catch {
    return Result.fail("request must be JSON-serializable");
  }
}

function parseFields(raw: RouteWire): Parsed<ModelRouteRequest> {
  if (!isFields(raw)) return Result.fail("request must be an object");

  for (const field of FORBIDDEN_FIELDS) {
    if (Object.hasOwn(raw, field)) {
      return Result.fail(`request must not include provider field: ${field}`);
    }
  }

  const msgs = raw.messages;

  if (!isEntries(msgs) || msgs.length === 0) {
    return Result.fail("messages must be a non-empty array");
  }

  return Result.gen(function* () {
    const bytes = yield* wireBytes(raw);

    if (bytes > MAX_REQUEST_BYTES) return yield* Result.fail("request exceeds 1 MiB size limit");

    return yield* Result.mapError(decodeRequest(raw), decodeReason);
  });
}

export function parseRequest(raw: RouteWire): Result.Result<ModelRouteRequest, ValidationFailure> {
  return Result.mapError(parseFields(raw), (reason): ValidationFailure => ({
    ok: false,
    error: { code: "invalid-request", reason },
  }));
}
