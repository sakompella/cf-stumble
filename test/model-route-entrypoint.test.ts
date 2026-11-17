import { exports as workerExports } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { GENERATION_REPLACED } from "../src/generation-replaced.js";
import { ModelRoute } from "../src/model-route.js";
import { ROUTE_FAILURE } from "../src/model-route-wire/failure.js";
import {
  collectEvents,
  DONE_LINE,
  providerStreamOfLines,
  sseLine,
} from "./model-route-provider-stream.js";
import type { ChatGPTAccess } from "../src/chatgpt/index.js";
import type { StreamingProviderPayload, WorkersAiBinding } from "../src/model-route-wire/events.js";
import type { ModelRouteRequest, ValidationFailure } from "../src/model-route-wire/request.js";

type RecordedCall = Readonly<{
  model: string;
  input: StreamingProviderPayload;
  headers: Record<string, string>;
}>;

type FakeBinding = Readonly<{ ai: WorkersAiBinding; calls: readonly RecordedCall[] }>;

function fakeAiBinding(answer: () => Promise<ReadableStream<Uint8Array>>): FakeBinding {
  const calls: RecordedCall[] = [];

  const binding: WorkersAiBinding = {
    run(model, input, options) {
      calls.push({ model, input, headers: options.extraHeaders });

      return answer();
    },
  };

  return { ai: binding, calls };
}

function bindingStreaming(lines: readonly string[]): FakeBinding {
  return fakeAiBinding(() => Promise.resolve(providerStreamOfLines(lines)));
}

function supervisedRoute(binding: FakeBinding, access: ChatGPTAccess, serving = true): ModelRoute {
  const context = createExecutionContext();
  Object.defineProperty(context, "props", { value: { supervisor: "owner", instance: 0 } });

  return new ModelRoute(context, {
    AI: binding.ai,
    SUPERVISOR: {
      getByName: (name) => {
        expect(name).toBe("owner");

        return {
          admitModelTurn: (instance) => Promise.resolve(serving && instance === 0),
          chatgptAccess: () => Promise.resolve(access),
          markChatGPTRefused: () => Promise.resolve(),
          markChatGPTUsageLimited: () => Promise.resolve(),
        };
      },
    },
    CHATGPT_MODEL: "gpt-test",
  });
}

function routeOver(binding: FakeBinding): ModelRoute {
  return supervisedRoute(binding, { kind: "not-connected" });
}

async function streamOf(
  pending: Promise<ReadableStream<Uint8Array> | ValidationFailure>,
): Promise<ReadableStream<Uint8Array>> {
  const outcome = await pending;

  if (outcome instanceof ReadableStream) return outcome;
  throw new Error(`the entrypoint refused the request: ${outcome.error.reason}`);
}

test("a Supervisor's route refuses a facet whose serving instance was replaced, before any model call", async () => {
  const binding = bindingStreaming([sseLine({ response: "ok" }), DONE_LINE]);
  const route = supervisedRoute(binding, { kind: "not-connected" }, false);

  expect(await route.runStream(REQUEST)).toEqual({
    ok: false,
    error: { code: "invalid-request", reason: GENERATION_REPLACED },
  });

  expect(binding.calls).toEqual([]);
});

const REQUEST: ModelRouteRequest = { messages: [{ role: "user", content: "hi" }] };

test("a Supervisor admission that rejects answers a retryable model-unavailable stream, before any model call", async () => {
  const binding = bindingStreaming([DONE_LINE]);
  const context = createExecutionContext();
  Object.defineProperty(context, "props", { value: { supervisor: "owner", instance: 0 } });

  const route = new ModelRoute(context, {
    AI: binding.ai,
    SUPERVISOR: {
      getByName: () => ({
        admitModelTurn: () => Promise.reject(new Error("the supervisor went away")),
        chatgptAccess: () => Promise.reject(new Error("unreachable")),
        markChatGPTRefused: () => Promise.reject(new Error("unreachable")),
        markChatGPTUsageLimited: () => Promise.reject(new Error("unreachable")),
      }),
    },
    CHATGPT_MODEL: "gpt-test",
  });

  const events = await collectEvents(await streamOf(route.runStream(REQUEST)));

  expect(events).toEqual([
    {
      type: "error",
      error: { code: "model-unavailable", detail: ROUTE_FAILURE.supervisorUnavailable },
    },
  ]);
  expect(binding.calls).toEqual([]);
});

test("a request that names its own model is refused as a plain value and never reaches the binding", async () => {
  const binding = bindingStreaming([DONE_LINE]);

  const outcome = await routeOver(binding).runStream({
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

  const events = await collectEvents(await streamOf(routeOver(binding).runStream(REQUEST)));
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

test("the deployed entrypoint refuses a bad runStream request across its own service-binding hop", async () => {
  const refused = await workerExports.ModelRoute({}).runStream({ messages: [] });

  expect(refused).toEqual({
    ok: false,
    error: { code: "invalid-request", reason: "messages must be a non-empty array" },
  } satisfies ValidationFailure);
});

test("with no ChatGPT connection, the route asks Workers AI with the normalized messages under the Supervisor's session affinity, and served names the fallback", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const binding = bindingStreaming([sseLine({ response: "fallback" }), DONE_LINE]);

  const events = await collectEvents(
    await streamOf(
      routeOver(binding).runStream({ messages: [{ role: "user", content: "hi", name: "owner" }] }),
    ),
  );

  expect(fetchSpy).not.toHaveBeenCalled();
  expect(binding.calls.map(({ input, headers }) => [input.messages, headers])).toEqual([
    [[{ role: "user", content: "hi" }], { "x-session-affinity": "owner" }],
  ]);
  expect(events.filter((event) => event.type === "provider-fallback")).toEqual([]);
  expect(events.at(-1)).toMatchObject({
    type: "done",
    message: { content: "fallback" },
    served: {
      provider: "workers-ai",
      model: "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
      effort: "low",
      fallback: "chatgpt-not-connected",
    },
  });
});

test("a ChatGPT grant that needs a reconnect fails the call and never falls back to Workers AI", async () => {
  const binding = bindingStreaming([sseLine({ response: "fallback" }), DONE_LINE]);

  const events = await collectEvents(
    await streamOf(supervisedRoute(binding, { kind: "reconnect-required" }).runStream(REQUEST)),
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

  const events = await collectEvents(await streamOf(routeOver(binding).runStream(REQUEST)));
  expect(events.at(-1)).toMatchObject({ type: "done", truncated: true });
});

test("a Workers AI answer that stops on its own ends with a done that is not truncated", async () => {
  const binding = bindingStreaming([
    sseLine({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }),
    DONE_LINE,
  ]);

  const events = await collectEvents(await streamOf(routeOver(binding).runStream(REQUEST)));
  expect(events.at(-1)).toMatchObject({ type: "done", message: { content: "ok" } });
  expect(events.at(-1)).not.toHaveProperty("truncated");
});
