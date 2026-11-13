import * as Data from "effect/Data";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { logEvent, type LogFields } from "../diagnostics.js";
import type { ModelUsage } from "../model-route-wire/events.js";
import type { ResponsesRequestBody } from "./responses.js";

export class ChatGPTNotConnected extends Data.TaggedError("ChatGPTNotConnected") {}

export class ChatGPTUsageLimited extends Data.TaggedError("ChatGPTUsageLimited")<{
  readonly limitedUntil: number | null;
}> {}

type PromptFingerprints = Readonly<{
  instructionsHash: string;
  toolsHash: string;
  firstInputHash: string;
  inputItems: number;
}>;

async function shortHash(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );

  return Array.from(digest.slice(0, 6), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function promptFingerprints(body: ResponsesRequestBody): Promise<PromptFingerprints> {
  const first = body.input[0];

  const [instructionsHash, toolsHash, firstInputHash] = await Promise.all([
    shortHash(body.instructions ?? ""),
    shortHash(JSON.stringify(body.tools ?? [])),
    shortHash(first === undefined ? "" : JSON.stringify(first)),
  ]);

  return { instructionsHash, toolsHash, firstInputHash, inputItems: body.input.length };
}

let usageFieldsLogged = false;

export async function logAnsweredCall(
  model: string,
  usage: ModelUsage,
  body: ResponsesRequestBody,
  usageFields: readonly string[] | undefined,
  cacheWriteTokens: number | undefined,
): Promise<void> {
  const fingerprints = await promptFingerprints(body);

  const fields: LogFields = {
    outcome: "ok",
    model,
    promptTokens: usage.inputTokens,
    cachedTokens: usage.cachedTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? null,
    completionTokens: usage.outputTokens,
    estimated: usage.estimated,
    ...fingerprints,
  };

  const firstUsage = usageFields !== undefined && !usageFieldsLogged;

  if (usageFields !== undefined) usageFieldsLogged = true;

  logEvent(
    "info",
    "chatgpt.model-call",
    firstUsage ? { ...fields, usageFields: usageFields.join(",") } : fields,
  );
}

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);

const isJsonRecord = Schema.is(JsonRecord);

const UsageFieldsSchema = Schema.Struct({
  response: Schema.Struct({ usage: JsonRecord }),
});

const decodeUsageFields = Schema.decodeUnknownOption(Schema.fromJsonString(UsageFieldsSchema));

export function usageFieldNames(data: string): readonly string[] | undefined {
  return decodeUsageFields(data).pipe(
    Option.map(({ response }) =>
      Object.entries(response.usage).flatMap(([key, value]) =>
        isJsonRecord(value)
          ? [key, ...Object.keys(value).map((child) => `${key}.${child}`)]
          : [key],
      ),
    ),
    Option.getOrElse((): readonly string[] | undefined => undefined),
  );
}
