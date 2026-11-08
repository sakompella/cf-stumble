import { exports as workerExports } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { expect, test } from "vitest";
import { GENERATION_REPLACED } from "../src/generation-replaced.js";
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

test("with no ChatGPT credential connected, the Supervisor's route answers from Workers AI", async () => {
  const binding = bindingStreaming([sseLine({ response: "fallback" }), DONE_LINE]);

  const events = await collectEvents(await streamOf(routeOver(binding).runStream(REQUEST)));

  expect(binding.calls).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ type: "done", message: { content: "fallback" } });
});

test("a Supervisor's route sends the binding the normalized messages", async () => {
  const binding = bindingStreaming([sseLine({ response: "ok" }), DONE_LINE]);

  await collectEvents(
    await streamOf(
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
