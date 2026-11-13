import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { chatgptTurn } from "../../src/chatgpt/index.js";
import { modelEventStream } from "../../src/model-route-turn.js";
import type { ModelRouteRequest } from "../../src/model-route-wire/request.js";
import { capturedEvents, named } from "../log-capture.js";
import { collectEvents } from "../model-route-provider-stream.js";
import {
  ACCESS_ONE,
  bodyOf,
  fakeCredential,
  ready,
  recordingFetch,
  responsesEvent,
  sseResponse,
} from "./fixtures.js";

const CACHED = responsesEvent({
  type: "response.completed",
  response: {
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 64, cache_write_tokens: 32 },
      output_tokens: 3,
    },
  },
});

async function turnOf(request: ModelRouteRequest) {
  const { fetcher, calls } = recordingFetch(() =>
    Promise.resolve(
      sseResponse([responsesEvent({ type: "response.output_text.delta", delta: "ok" }), CACHED]),
    ),
  );

  const turn = chatgptTurn(
    { credential: fakeCredential([ready(ACCESS_ONE)]), fetcher, model: "gpt-test" },
    request,
  );

  const events = await collectEvents(
    modelEventStream((emit) =>
      turn(emit).pipe(
        Effect.catchTag(["ChatGPTNotConnected", "ChatGPTUsageLimited"], () =>
          Effect.die(new Error("this test expects a connected credential with no usage limit")),
        ),
      ),
    ),
  );

  return { events, body: bodyOf(calls[0]) };
}

async function hash12(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );

  return Array.from(digest.slice(0, 6), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const HI: ModelRouteRequest = { messages: [{ role: "user", content: "hi" }] };

test("the first answered call in an isolate logs the prompt fingerprints and the usage fields", async () => {
  const logged = capturedEvents();
  await turnOf(HI);
  await turnOf({ ...HI, messages: [{ role: "system", content: "s" }, ...HI.messages] });

  const rows = named(logged(), "chatgpt.model-call");

  expect(rows[0]).toEqual(
    expect.objectContaining({
      instructionsHash: await hash12(""),
      toolsHash: await hash12("[]"),
      firstInputHash: await hash12('{"role":"user","content":"hi"}'),
      inputItems: 1,
      usageFields:
        "input_tokens,input_tokens_details,input_tokens_details.cached_tokens,input_tokens_details.cache_write_tokens,output_tokens",
    }),
  );
  expect(rows[1]).toEqual(
    expect.objectContaining({ instructionsHash: await hash12("s"), inputItems: 1 }),
  );
  expect(rows[1]).not.toHaveProperty("usageFields");
});

test("an answered call reports its cached tokens, names who served it, and is logged as ok", async () => {
  const logged = capturedEvents();
  const { events } = await turnOf(HI);

  expect(events.at(-1)).toEqual({
    type: "done",
    message: { role: "assistant", content: "ok", tool_calls: [] },
    usage: { inputTokens: 100, cachedTokens: 64, outputTokens: 3, estimated: false },
    served: { provider: "chatgpt", model: "gpt-test", effort: "medium" },
  });
  expect(named(logged(), "chatgpt.model-call")).toEqual([
    expect.objectContaining({
      outcome: "ok",
      model: "gpt-test",
      promptTokens: 100,
      cachedTokens: 64,
      cacheWriteTokens: 32,
      completionTokens: 3,
      estimated: false,
    }),
  ]);
});

test("the request carries the conversation's prompt cache key only when it has one", async () => {
  const keyed = await turnOf({ ...HI, promptCacheKey: "conversation-key" });
  const plain = await turnOf(HI);

  expect(JSON.parse(keyed.body)).toMatchObject({ prompt_cache_key: "conversation-key" });
  expect(JSON.parse(plain.body)).not.toHaveProperty("prompt_cache_key");
});
