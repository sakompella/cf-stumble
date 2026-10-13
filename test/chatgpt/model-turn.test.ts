import * as Effect from "effect/Effect";
import { afterEach, expect, test, vi } from "vitest";
import {
  chatgptTurn,
  type ChatGPTAccess,
  type ChatGPTCredential,
} from "../../src/chatgpt/index.js";
import { modelEventStream } from "../../src/model-route-turn.js";
import type { ModelRouteRequest } from "../../src/model-route.js";
import { capturedEvents, everythingLogged, named } from "../log-capture.js";
import { collectEvents } from "../model-route-provider-stream.js";
import {
  ACCESS_ONE,
  ACCESS_TWO,
  COMPLETED,
  recordingFetch,
  responsesEvent,
  sseResponse,
  type RecordedCall,
} from "./fixtures.js";

/**
 * One ChatGPT model call, driven by a fake credential holder and a fake Responses endpoint, and
 * read back as the model route's own event stream.
 */

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

type FakeCredential = ChatGPTCredential & {
  readonly asked: (string | undefined)[];
  readonly refused: string[];
};

/** A credential holder that answers each `access` call with the next entry of `answers`. */
function fakeCredential(answers: readonly ChatGPTAccess[]): FakeCredential {
  const asked: (string | undefined)[] = [];
  const refused: string[] = [];

  return {
    asked,
    refused,
    access: (rejected) => {
      asked.push(rejected);

      return Promise.resolve(answers[asked.length - 1] ?? { kind: "unavailable" });
    },
    markRefused: (token) => {
      refused.push(token);

      return Promise.resolve();
    },
  };
}

function run(
  credential: ChatGPTCredential,
  reply: (call: RecordedCall) => Promise<Response>,
): Promise<Readonly<{ events: Awaited<ReturnType<typeof collectEvents>>; calls: RecordedCall[] }>> {
  const { fetcher, calls } = recordingFetch(reply);
  const turn = chatgptTurn({ credential, fetcher, model: "gpt-test" }, REQUEST);

  const stream = modelEventStream((emit) =>
    turn(emit).pipe(
      Effect.catchTag("ChatGPTNotConnected", () =>
        Effect.die(new Error("this test expects a connected credential")),
      ),
    ),
  );

  return collectEvents(stream).then((events) => ({ events, calls }));
}

const ready = (accessToken: string): ChatGPTAccess => ({ kind: "ready", accessToken });

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
  // oxlint-disable-next-line typescript/no-base-to-string -- The request body is a JSON string.
  const body = String(call?.init.body);
  expect(body).not.toContain(ACCESS_ONE);
  expect(JSON.parse(body)).toEqual({
    model: "gpt-test",
    instructions: "You are a coding assistant.",
    input: [
      { role: "user", content: "Read a.txt" },
      { role: "assistant", content: "Reading it." },
      { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a.txt"}' },
      { type: "function_call_output", call_id: "call_1", output: "hello" },
    ],
    tools: [
      {
        type: "function",
        name: "read",
        description: "Read a file",
        parameters: { type: "object" },
        strict: false,
      },
    ],
    reasoning: { effort: "medium" },
    store: false,
    stream: true,
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

test("a revoked grant fails the call before anything is sent", async () => {
  const { events, calls } = await run(fakeCredential([{ kind: "reconnect-required" }]), () =>
    Promise.reject(new Error("must not be called")),
  );

  expect(events).toEqual([{ type: "error", error: { code: "chatgpt-reconnect-required" } }]);
  expect(calls).toEqual([]);
});

test("a provider failure keeps the text already streamed, logs only its code, and errors the call", async () => {
  const logged = capturedEvents();

  const { events } = await run(fakeCredential([ready(ACCESS_ONE)]), () =>
    Promise.resolve(
      sseResponse([
        responsesEvent({ type: "response.output_text.delta", delta: "part" }),
        responsesEvent({
          type: "response.failed",
          response: {
            error: { code: "subscription_sharing_usage_limit_exceeded", message: "Read a.txt" },
          },
        }),
      ]),
    ),
  );

  expect(events).toEqual([
    { type: "text-delta", delta: "part" },
    { type: "error", error: { code: "model-unavailable" } },
  ]);
  expect(named(logged(), "chatgpt.model-call")).toEqual([
    expect.objectContaining({
      outcome: "stream-failed",
      code: "subscription_sharing_usage_limit_exceeded",
    }),
  ]);
  expect(everythingLogged()).not.toContain("Read a.txt");
});

test("an HTTP refusal and a stream that stops early both end as model-unavailable", async () => {
  const refused = await run(fakeCredential([ready(ACCESS_ONE)]), () =>
    Promise.resolve(
      Response.json({ error: { code: "subscription_sharing_user_not_eligible" } }, { status: 403 }),
    ),
  );

  const truncated = await run(fakeCredential([ready(ACCESS_ONE)]), () =>
    Promise.resolve(
      sseResponse([responsesEvent({ type: "response.output_text.delta", delta: "x" })]),
    ),
  );

  expect(refused.events).toEqual([{ type: "error", error: { code: "model-unavailable" } }]);
  expect(truncated.events.at(-1)).toEqual({ type: "error", error: { code: "model-unavailable" } });
});

test("no connected credential is a typed failure the route can fall back on", async () => {
  const { fetcher, calls } = recordingFetch(() => Promise.reject(new Error("must not be called")));

  const outcome = await Effect.runPromise(
    chatgptTurn(
      { credential: fakeCredential([{ kind: "not-connected" }]), fetcher, model: "m" },
      REQUEST,
    )(() => {}).pipe(
      Effect.as("answered"),
      Effect.catchTag("ChatGPTNotConnected", () => Effect.succeed("not-connected")),
      Effect.catchTag("ModelTurnFailed", () => Effect.succeed("failed")),
    ),
  );

  expect(outcome).toBe("not-connected");
  expect(calls).toEqual([]);
});
