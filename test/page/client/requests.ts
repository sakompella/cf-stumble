import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { vi } from "vitest";
import type { Model } from "../../../src/page/client/model.js";
import { update } from "../../../src/page/client/update.js";
import { openedTranscript } from "./transcript-resource.js";

type UpdateResult = ReturnType<typeof update>;

type Command = NonNullable<UpdateResult["commands"]>[number];

export type SentRequest = Readonly<{ method: string; path: string; body: unknown }>;

export type Answer = (request: SentRequest) => Promise<Response>;

const transcript = openedTranscript();

const decodeBody = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

export async function settled(
  { model, commands }: UpdateResult,
  answer: Answer,
): Promise<{ model: Model; sent: readonly SentRequest[] }> {
  const sent: SentRequest[] = [];

  vi.stubGlobal("fetch", (path: string, request?: RequestInit) => {
    const noted = {
      method: String(request?.method),
      path,
      body: request?.body === undefined || request.body === null ? null : decodeBody(request.body),
    };

    sent.push(noted);

    return answer(noted);
  });

  return { model: await ran(model, commands ?? []), sent };
}

async function ran(model: Model, commands: readonly Command[]): Promise<Model> {
  const [command, ...rest] = commands;

  if (command === undefined) return model;

  const next = update(model, await Effect.runPromise(transcript.provide(command.effect)));

  return ran(next.model, [...rest, ...(next.commands ?? [])]);
}
