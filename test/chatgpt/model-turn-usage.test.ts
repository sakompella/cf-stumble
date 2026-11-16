import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect, test } from "vitest";
import { chatgptTurn } from "../../src/chatgpt/index.js";
import { modelEventStream } from "../../src/model-route-turn.js";
import type { ModelRouteRequest } from "../../src/model-route-wire/request.js";
import { capturedEvents, everythingLogged, named } from "../log-capture.js";
import { collectEvents } from "../model-route-provider-stream.js";
import {
  ACCESS_ONE,
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
  const { fetcher } = recordingFetch(() =>
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

  return { events };
}

const HI: ModelRouteRequest = { messages: [{ role: "user", content: "Read notes.txt" }] };

const WITH_SYSTEM: ModelRouteRequest = {
  messages: [{ role: "system", content: "You review code." }, ...HI.messages],
};

const WITH_OTHER_INPUT: ModelRouteRequest = {
  messages: [{ role: "user", content: "Summarize the diff" }],
};

const decodeModelCall = Schema.decodeUnknownSync(
  Schema.Struct({
    instructionsHash: Schema.String,
    toolsHash: Schema.String,
    firstInputHash: Schema.String,
    inputItems: Schema.Number,
    usageFields: Schema.optionalKey(Schema.String),
  }),
);

const WITH_TOOLS: ModelRouteRequest = {
  messages: [...HI.messages],
  tools: [
    {
      type: "function",
      function: { name: "read_file", description: "Read a file", parameters: { type: "object" } },
    },
  ],
};

test("an answered call logs prompt fingerprints that describe its instructions, tools and first input, never the prompt itself", async () => {
  const logged = capturedEvents();
  await turnOf(HI);
  await turnOf(HI);
  await turnOf(WITH_SYSTEM);
  await turnOf(WITH_OTHER_INPUT);
  await turnOf(WITH_TOOLS);

  const [first, again, otherInstructions, otherInput, otherTools] = named(
    logged(),
    "chatgpt.model-call",
  ).map((row) => decodeModelCall(row));

  for (const row of [first, again, otherInstructions, otherInput, otherTools]) {
    expect(row?.instructionsHash ?? "").not.toBe("");
    expect(row?.toolsHash ?? "").not.toBe("");
    expect(row?.firstInputHash ?? "").not.toBe("");
  }

  expect(again).toMatchObject({
    instructionsHash: first?.instructionsHash,
    toolsHash: first?.toolsHash,
    firstInputHash: first?.firstInputHash,
    inputItems: 1,
  });
  expect(otherInstructions).toMatchObject({
    toolsHash: first?.toolsHash,
    firstInputHash: first?.firstInputHash,
    inputItems: 1,
  });
  expect(otherInstructions?.instructionsHash).not.toBe(first?.instructionsHash);
  expect(otherInput).toMatchObject({
    instructionsHash: first?.instructionsHash,
    toolsHash: first?.toolsHash,
    inputItems: 1,
  });
  expect(otherInput?.firstInputHash).not.toBe(first?.firstInputHash);
  expect(otherTools).toMatchObject({
    instructionsHash: first?.instructionsHash,
    firstInputHash: first?.firstInputHash,
    inputItems: 1,
  });
  expect(otherTools?.toolsHash).not.toBe(first?.toolsHash);
  expect(everythingLogged()).not.toContain("notes.txt");
  expect(everythingLogged()).not.toContain("You review code");
  expect(everythingLogged()).not.toContain("Summarize the diff");
  expect(first?.usageFields).toBe(
    "input_tokens,input_tokens_details,input_tokens_details.cached_tokens,input_tokens_details.cache_write_tokens,output_tokens",
  );
  expect(again).not.toHaveProperty("usageFields");
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
