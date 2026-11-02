import { env, exports as workerExports } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { expect, test } from "vitest";
import { ModelRoute } from "../src/model-route.js";
import {
  collectEvents,
  DONE_LINE,
  providerStreamOfLines,
  sseLine,
} from "./model-route-provider-stream.js";
import type { ChatGPTAccess } from "../src/chatgpt/index.js";
import type { StreamingProviderPayload, WorkersAiBinding } from "../src/model-route-events.js";
import type { ModelRouteRequest, ValidationFailure } from "../src/model-route.js";

type RecordedCall = Readonly<{ model: string; input: StreamingProviderPayload }>;

type FakeBinding = Readonly<{ ai: WorkersAiBinding; calls: readonly RecordedCall[] }>;

function fakeAiBinding(answer: () => Promise<ReadableStream<Uint8Array>>): FakeBinding {
  const calls: RecordedCall[] = [];

  const binding: WorkersAiBinding = {
    run(model, input) {
      calls.push({ model, input });

      return answer();
    },
  };

  return { ai: binding, calls };
}

function bindingStreaming(lines: readonly string[]): FakeBinding {
  return fakeAiBinding(() => Promise.resolve(providerStreamOfLines(lines)));
}

type CredentialHolder = Readonly<{
  chatgptAccess(rejected?: string): Promise<ChatGPTAccess>;
  markChatGPTRefused(accessToken: string): Promise<void>;
  markChatGPTUsageLimited(accessToken: string, limitedUntil: number | null): Promise<void>;
}>;

const NO_SUPERVISOR = {
  getByName(): CredentialHolder {
    throw new Error("a route no Supervisor created must not look for one");
  },
};

function routeOver(binding: FakeBinding): ModelRoute {
  return new ModelRoute(createExecutionContext(), {
    AI: binding.ai,
    SUPERVISOR: NO_SUPERVISOR,
    CHATGPT_MODEL: "gpt-test",
  });
}

function supervisedRoute(binding: FakeBinding, access: ChatGPTAccess): ModelRoute {
  const context = createExecutionContext();
  Object.defineProperty(context, "props", { value: { supervisor: "owner" } });

  return new ModelRoute(context, {
    AI: binding.ai,
    SUPERVISOR: {
      getByName: (name) => {
        expect(name).toBe("owner");

        return {
          chatgptAccess: () => Promise.resolve(access),
          markChatGPTRefused: () => Promise.resolve(),
          markChatGPTUsageLimited: () => Promise.resolve(),
        };
      },
    },
    CHATGPT_MODEL: "gpt-test",
  });
}

function streamOf(
  outcome: ReadableStream<Uint8Array> | ValidationFailure,
): ReadableStream<Uint8Array> {
  if (outcome instanceof ReadableStream) return outcome;
  throw new Error(`the entrypoint refused the request: ${outcome.error.reason}`);
}

const REQUEST: ModelRouteRequest = { messages: [{ role: "user", content: "hi" }] };

test("the entrypoint answers a provider's two text deltas with exactly those two text events and one terminal event", async () => {
  const binding = bindingStreaming([
    sseLine({ response: "Hel" }),
    sseLine({ response: "lo" }),
    DONE_LINE,
  ]);

  const events = await collectEvents(streamOf(routeOver(binding).runStream(REQUEST)));
  expect(events).toHaveLength(3);
  expect(events.slice(0, 2)).toEqual([
    { type: "text-delta", delta: "Hel" },
    { type: "text-delta", delta: "lo" },
  ]);
  const done = events[2];

  if (done?.type !== "done") throw new Error("the entrypoint sent no terminal done event");
  expect(done.message).toEqual({ role: "assistant", content: "Hello", tool_calls: [] });
  expect(done.usage.estimated).toBe(true);
  expect(done.usage.outputTokens).toBeGreaterThan(0);
});

test("a request that names its own model is refused as a plain value and never reaches the binding", () => {
  const binding = bindingStreaming([DONE_LINE]);

  const outcome = routeOver(binding).runStream({
    messages: [{ role: "user", content: "hi" }],
    model: "@cf/some/other-model",
  });

  expect(outcome).toEqual({
    ok: false,
    error: {
      code: "invalid-request",
      reason: "request must not include provider field: model",
    },
  } satisfies ValidationFailure);
  expect(binding.calls).toEqual([]);
});

test("a binding call that rejects becomes exactly one terminal error event", async () => {
  const binding = fakeAiBinding(() => Promise.reject(new Error("provider secret leaked")));
  const events = await collectEvents(streamOf(routeOver(binding).runStream(REQUEST)));
  expect(events).toEqual([{ type: "error", error: { code: "model-unavailable" } }]);
});

test("a provider stream that stops before its terminal marker keeps the text it sent, then errors", async () => {
  const binding = bindingStreaming([sseLine({ response: "partial" })]);
  const events = await collectEvents(streamOf(routeOver(binding).runStream(REQUEST)));
  expect(events).toEqual([
    { type: "text-delta", delta: "partial" },
    { type: "error", error: { code: "model-unavailable" } },
  ]);
});

test("two tool calls the provider reports without an index stay two separate calls", async () => {
  const binding = bindingStreaming([
    sseLine({
      tool_calls: [
        { id: "call_1", function: { name: "read_file", arguments: '{"path":"a"}' } },
        { id: "call_2", function: { name: "write_file", arguments: '{"path":"b"}' } },
      ],
    }),
    DONE_LINE,
  ]);

  const events = await collectEvents(streamOf(routeOver(binding).runStream(REQUEST)));
  expect(events.at(-1)).toMatchObject({
    type: "done",
    message: {
      tool_calls: [
        { id: "call_1", function: { name: "read_file", arguments: '{"path":"a"}' } },
        { id: "call_2", function: { name: "write_file", arguments: '{"path":"b"}' } },
      ],
    },
  });
});

test("the deployed entrypoint refuses an invalid request across its own service-binding hop", async () => {
  const refused = await workerExports.ModelRoute({}).runStream({ messages: [] });

  expect(refused).toEqual({
    ok: false,
    error: { code: "invalid-request", reason: "messages must be a non-empty array" },
  } satisfies ValidationFailure);
});

test("the deployed entrypoint streams a Workers AI answer across its own service-binding hop", async () => {
  const binding = bindingStreaming([sseLine({ response: "over rpc" }), DONE_LINE]);

  Object.defineProperty(env, "AI", { value: binding.ai, configurable: true });

  try {
    const outcome = await workerExports.ModelRoute({}).runStream(REQUEST);
    const events = await collectEvents(streamOf(outcome));

    expect(events.at(-1)).toMatchObject({ type: "done", message: { content: "over rpc" } });
  } finally {
    Object.defineProperty(env, "AI", { value: undefined, configurable: true });
  }
});

test("with no ChatGPT credential connected, the Supervisor's route answers from Workers AI", async () => {
  const binding = bindingStreaming([sseLine({ response: "fallback" }), DONE_LINE]);

  const events = await collectEvents(
    streamOf(supervisedRoute(binding, { kind: "not-connected" }).runStream(REQUEST)),
  );

  expect(binding.calls).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ type: "done", message: { content: "fallback" } });
});

test("a Supervisor's route sends the binding the normalized messages", async () => {
  const binding = bindingStreaming([sseLine({ response: "ok" }), DONE_LINE]);

  await collectEvents(
    streamOf(
      supervisedRoute(binding, { kind: "not-connected" }).runStream({
        messages: [{ role: "user", content: "hi", name: "owner" }],
      }),
    ),
  );

  expect(binding.calls.map((call) => call.input.messages)).toEqual([
    [{ role: "user", content: "hi" }],
  ]);
});

test("a ChatGPT grant that needs a reconnect fails the call and never falls back to Workers AI", async () => {
  const binding = bindingStreaming([sseLine({ response: "fallback" }), DONE_LINE]);

  const events = await collectEvents(
    streamOf(supervisedRoute(binding, { kind: "reconnect-required" }).runStream(REQUEST)),
  );

  expect(events).toEqual([{ type: "error", error: { code: "chatgpt-reconnect-required" } }]);
  expect(binding.calls).toEqual([]);
});

test("a Workers AI answer cut off at max_tokens ends with a truncated done", async () => {
  const binding = bindingStreaming([
    sseLine({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                function: { name: "write", arguments: '{"path":"a.ts","content":"export const' },
              },
            ],
          },
        },
      ],
    }),
    sseLine({ choices: [{ delta: {}, finish_reason: "length" }] }),
    DONE_LINE,
  ]);

  const events = await collectEvents(streamOf(routeOver(binding).runStream(REQUEST)));
  expect(events.at(-1)).toMatchObject({ type: "done", truncated: true });
});

test("a Workers AI answer that stops on its own ends with a done that is not truncated", async () => {
  const binding = bindingStreaming([
    sseLine({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
    DONE_LINE,
  ]);

  const events = await collectEvents(streamOf(routeOver(binding).runStream(REQUEST)));
  expect(events.at(-1)).toMatchObject({ type: "done", message: { content: "ok" } });
  expect(events.at(-1)).not.toHaveProperty("truncated");
});
