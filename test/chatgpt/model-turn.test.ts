import * as Effect from "effect/Effect";
import { afterEach, expect, test, vi } from "vitest";
import { chatgptTurn, type ChatGPTCredential } from "../../src/chatgpt/index.js";
import { modelEventStream } from "../../src/model-route-turn.js";
import type { ModelRouteRequest } from "../../src/model-route-wire/request.js";
import { capturedEvents, everythingLogged, named } from "../log-capture.js";
import { collectEvents } from "../model-route-provider-stream.js";
import {
  ACCESS_ONE,
  ACCESS_TWO,
  bodyOf,
  COMPLETED,
  fakeCredential,
  ready,
  recordingFetch,
  responsesEvent,
  sseResponse,
  type RecordedCall,
} from "./fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const REQUEST: ModelRouteRequest = {
  messages: [
    { role: "system", content: "You are a coding assistant." },
    { role: "user", content: "Read a.txt" },
    {
      role: "assistant",
      content: "Reading it.",
      tool_calls: [{ id: "call_1", function: { name: "read", arguments: '{"path":"a.txt"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "hello" },
  ],
  tools: [
    {
      type: "function",
      function: { name: "read", description: "Read a file", parameters: { type: "object" } },
    },
  ],
};

function run(
  credential: ChatGPTCredential,
  reply: (call: RecordedCall) => Promise<Response>,
): Promise<Readonly<{ events: Awaited<ReturnType<typeof collectEvents>>; calls: RecordedCall[] }>> {
  const { fetcher, calls } = recordingFetch(reply);
  const turn = chatgptTurn({ credential, fetcher, model: "gpt-test" }, REQUEST);

  const stream = modelEventStream((emit) =>
    turn(emit).pipe(
      Effect.catchTag(["ChatGPTNotConnected", "ChatGPTUsageLimited"], () =>
        Effect.die(new Error("this test expects a connected credential with no usage limit")),
      ),
    ),
  );

  return collectEvents(stream).then((events) => ({ events, calls }));
}

test("a Responses stream becomes text deltas, one assembled tool call, and the provider's usage", async () => {
  const { events } = await run(fakeCredential([ready(ACCESS_ONE)]), () =>
    Promise.resolve(
      sseResponse([
        responsesEvent({ type: "response.created", response: {} }),
        responsesEvent({
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "reasoning" },
        }),
        responsesEvent({ type: "response.output_text.delta", output_index: 1, delta: "Hel" }),
        responsesEvent({ type: "response.output_text.delta", output_index: 1, delta: "lo" }),
        responsesEvent({
          type: "response.output_item.added",
          output_index: 2,
          item: { type: "function_call", call_id: "call_9", name: "bash", arguments: "" },
        }),
        responsesEvent({
          type: "response.function_call_arguments.delta",
          output_index: 2,
          delta: '{"cmd":',
        }),
        responsesEvent({
          type: "response.function_call_arguments.delta",
          output_index: 2,
          delta: '"ls"}',
        }),
        COMPLETED,
      ]),
    ),
  );

  expect(events).toEqual([
    { type: "text-delta", delta: "Hel" },
    { type: "text-delta", delta: "lo" },
    { type: "tool-call-delta", delta: { index: 2, id: "call_9", name: "bash" } },
    { type: "tool-call-delta", delta: { index: 2, argumentsDelta: '{"cmd":' } },
    { type: "tool-call-delta", delta: { index: 2, argumentsDelta: '"ls"}' } },
    {
      type: "done",
      message: {
        role: "assistant",
        content: "Hello",
        tool_calls: [{ id: "call_9", function: { name: "bash", arguments: '{"cmd":"ls"}' } }],
      },
      usage: { inputTokens: 12, outputTokens: 3, estimated: false },
    },
  ]);
});

test("the request carries the conversation as Responses input, with the token only in Authorization", async () => {
  const { calls } = await run(fakeCredential([ready(ACCESS_ONE)]), () =>
    Promise.resolve(sseResponse([COMPLETED])),
  );

  const [call] = calls;
  expect(call?.url).toBe("https://api.openai.com/v1/responses");
  expect(call?.init.redirect).toBe("manual");
  expect(new Headers(call?.init.headers).get("authorization")).toBe(`Bearer ${ACCESS_ONE}`);
  const body = bodyOf(call);
  expect(body).not.toContain(ACCESS_ONE);
  expect(JSON.parse(body)).toMatchObject({
    model: "gpt-test",
    instructions: "You are a coding assistant.",
    stream: true,
    input: [
      { role: "user", content: "Read a.txt" },
      { role: "assistant", content: "Reading it." },
      { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a.txt"}' },
      { type: "function_call_output", call_id: "call_1", output: "hello" },
    ],
    tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
  });
});

test("a 401 is retried once with the token the holder gives for the refused one", async () => {
  const credential = fakeCredential([ready(ACCESS_ONE), ready(ACCESS_TWO)]);

  const { events, calls } = await run(credential, (call) =>
    Promise.resolve(
      new Headers(call.init.headers).get("authorization") === `Bearer ${ACCESS_ONE}`
        ? new Response("expired", { status: 401 })
        : sseResponse([
            responsesEvent({ type: "response.output_text.delta", delta: "ok" }),
            COMPLETED,
          ]),
    ),
  );

  expect(credential.asked).toEqual([undefined, ACCESS_ONE]);
  expect(calls).toHaveLength(2);
  expect(credential.refused).toEqual([]);
  expect(events.at(-1)).toMatchObject({ type: "done", message: { content: "ok" } });
});

test("a second 401 marks the refreshed token refused and says reconnect is required", async () => {
  const credential = fakeCredential([ready(ACCESS_ONE), ready(ACCESS_TWO)]);
  const logged = capturedEvents();

  const { events } = await run(credential, () =>
    Promise.resolve(new Response(`{"error":{"message":"bad ${ACCESS_TWO}"}}`, { status: 401 })),
  );

  expect(events).toEqual([{ type: "error", error: { code: "chatgpt-reconnect-required" } }]);
  expect(credential.refused).toEqual([ACCESS_TWO]);
  expect(named(logged(), "chatgpt.model-call").map((event) => event.outcome)).toEqual([
    "retrying",
    "refused",
  ]);
  expect(everythingLogged()).not.toMatch(/chatgpt-access-FAKE/u);
});

test("an error object without a type, then [DONE], keeps the text already streamed, logs the code, and errors the call", async () => {
  const logged = capturedEvents();
  const errorObject = { error: { code: "server_error", message: "Read a.txt" } };

  const { events } = await run(fakeCredential([ready(ACCESS_ONE)]), () =>
    Promise.resolve(
      sseResponse([
        responsesEvent({ type: "response.output_text.delta", delta: "part" }),
        `data: ${JSON.stringify(errorObject)}\n\n`,
        "data: [DONE]\n\n",
      ]),
    ),
  );

  expect(events).toEqual([
    { type: "text-delta", delta: "part" },
    { type: "error", error: { code: "model-unavailable", detail: "server_error" } },
  ]);
  expect(named(logged(), "chatgpt.model-call")).toEqual([
    expect.objectContaining({ outcome: "stream-failed", code: "server_error" }),
  ]);
  expect(everythingLogged()).not.toContain("Read a.txt");
});

test("an error body past its byte bound is not drained", async () => {
  const seen = { pulled: 0, cancelled: false };

  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      seen.pulled += 1;
      controller.enqueue(new TextEncoder().encode("x".repeat(2_048)));
    },
    cancel() {
      seen.cancelled = true;
    },
  });

  const { events } = await run(fakeCredential([ready(ACCESS_ONE)]), () =>
    Promise.resolve(new Response(body, { status: 503 })),
  );

  expect(events).toEqual([
    { type: "error", error: { code: "model-unavailable", detail: "503 unknown" } },
  ]);
  expect(seen.pulled).toBe(3);
  expect(seen.cancelled).toBe(true);
});

test("a refused HTTP call ends with its status and code, and not its message", async () => {
  const { events } = await run(fakeCredential([ready(ACCESS_ONE)]), () =>
    Promise.resolve(
      Response.json(
        { error: { type: "server_error", code: "server_is_overloaded", message: "Read a.txt" } },
        { status: 503 },
      ),
    ),
  );

  expect(events).toEqual([
    { type: "error", error: { code: "model-unavailable", detail: "503 server_is_overloaded" } },
  ]);
});

test("a stream that stops early ends as model-unavailable", async () => {
  const truncated = await run(fakeCredential([ready(ACCESS_ONE)]), () =>
    Promise.resolve(
      sseResponse([responsesEvent({ type: "response.output_text.delta", delta: "x" })]),
    ),
  );

  expect(truncated.events.at(-1)).toEqual({
    type: "error",
    error: { code: "model-unavailable", detail: "the stream ended without a terminal event" },
  });
});

test("usage the provider reports as a negative count is replaced by an estimate", async () => {
  const { events } = await run(fakeCredential([ready(ACCESS_ONE)]), () =>
    Promise.resolve(
      sseResponse([
        responsesEvent({ type: "response.output_text.delta", delta: "ok" }),
        responsesEvent({
          type: "response.completed",
          response: { usage: { input_tokens: 12, output_tokens: -3 } },
        }),
      ]),
    ),
  );

  expect(events.at(-1)).toMatchObject({ type: "done", usage: { estimated: true } });
});
