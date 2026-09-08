/// <reference types="@cloudflare/vitest-plugin/types" />

import { exports as workerExports } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { expect, test } from "vitest";
import { ModelRoute } from "../src/model-route.js";
import {
  collectEvents,
  DONE_LINE,
  providerStreamOfLines,
  sseLine,
} from "./model-route-provider-stream.js";
import type {
  ModelRouteRequest,
  StreamingProviderPayload,
  ValidationFailure,
} from "../src/model-route.js";

/**
 * `ModelRoute.runStream` itself, not the `streamModelEvents` helper behind it: the entrypoint the
 * Supervisor hands every facet through `ctx.exports.ModelRoute({})`. `test/model-route-stream.test.ts`
 * drives the helper directly, so the whole class could throw and stay green (recorded in
 * `.audit/v0/review-sol-tests.md`, finding 2). These tests construct the real entrypoint over a
 * scripted `AI.run`, and one of them calls it across the real service-binding RPC hop.
 *
 * Every asserted model id, payload field and event shape is written out literally here. Nothing
 * imports the production constant it is supposed to pin.
 */

/** The one model the immutable host is allowed to call, written out rather than imported. */
const REQUIRED_MODEL = "@cf/zai-org/glm-5.3-flash";

type RecordedCall = Readonly<{ model: string; input: StreamingProviderPayload }>;

type FakeBinding = Readonly<{ ai: Ai; calls: readonly RecordedCall[] }>;

/** A Workers AI binding whose `run` answers from `answer` and records what it was asked for. */
function fakeAiBinding(answer: () => Promise<ReadableStream<Uint8Array>>): FakeBinding {
  const calls: RecordedCall[] = [];
  const binding = {
    run(model: string, input: StreamingProviderPayload): Promise<ReadableStream<Uint8Array>> {
      calls.push({ model, input });
      return answer();
    },
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: `runStream` reaches the binding only through `AI.run`, which this object implements with the payload type that call passes; no other member of `Ai` is reachable from it.
  return { ai: binding as Ai, calls };
}

/** A binding that answers one scripted provider SSE stream, split one line per byte chunk. */
function bindingStreaming(lines: readonly string[]): FakeBinding {
  return fakeAiBinding(() => Promise.resolve(providerStreamOfLines(lines)));
}

function routeOver(binding: FakeBinding): ModelRoute {
  return new ModelRoute(createExecutionContext(), { AI: binding.ai });
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

test("the entrypoint asks the one fixed model with a streaming payload and nothing else", async () => {
  const binding = bindingStreaming([sseLine({ response: "ok" }), DONE_LINE]);
  await collectEvents(streamOf(routeOver(binding).runStream(REQUEST)));
  expect(binding.calls).toHaveLength(1);
  const call = binding.calls[0];
  if (call === undefined) throw new Error("the entrypoint never called the binding");
  expect(call.model).toBe(REQUIRED_MODEL);
  expect(Object.keys(call.input).toSorted()).toEqual([
    "max_tokens",
    "messages",
    "reasoning_effort",
    "stream",
  ]);
  expect(call.input.stream).toBe(true);
  expect(call.input.max_tokens).toBe(4096);
  expect(call.input.messages).toEqual([{ role: "user", content: "hi" }]);
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

test("malformed provider lines are skipped and the deltas around them still arrive exactly once", async () => {
  const binding = bindingStreaming([
    "event: ping\n",
    ": a comment line\n",
    "data: {not json at all\n",
    sseLine("a bare string, not an object"),
    sseLine({ response: "one" }),
    sseLine({ response: "" }),
    sseLine({ unrecognised: { field: 1 } }),
    sseLine({ response: "two" }),
    DONE_LINE,
  ]);
  const events = await collectEvents(streamOf(routeOver(binding).runStream(REQUEST)));
  expect(events.filter((event) => event.type === "text-delta")).toEqual([
    { type: "text-delta", delta: "one" },
    { type: "text-delta", delta: "two" },
  ]);
  expect(events.at(-1)).toMatchObject({ type: "done", message: { content: "onetwo" } });
  expect(events).toHaveLength(3);
});

test("the entrypoint assembles one tool call whose id, name and argument fragments arrive on separate chunks", async () => {
  const binding = bindingStreaming([
    sseLine({ tool_calls: [{ index: 0, id: "call_1", function: { name: "bash" } }] }),
    sseLine({ tool_calls: [{ index: 0, function: { arguments: '{"cmd":' } }] }),
    sseLine({ tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }),
    DONE_LINE,
  ]);
  const events = await collectEvents(streamOf(routeOver(binding).runStream(REQUEST)));
  expect(events.filter((event) => event.type === "tool-call-delta")).toEqual([
    { type: "tool-call-delta", delta: { index: 0, id: "call_1", name: "bash" } },
    { type: "tool-call-delta", delta: { index: 0, argumentsDelta: '{"cmd":' } },
    { type: "tool-call-delta", delta: { index: 0, argumentsDelta: '"ls"}' } },
  ]);
  expect(events.at(-1)).toMatchObject({
    type: "done",
    message: {
      content: null,
      tool_calls: [{ id: "call_1", function: { name: "bash", arguments: '{"cmd":"ls"}' } }],
    },
  });
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

test("the entrypoint reports the provider's own input_tokens/output_tokens as a measurement", async () => {
  const binding = bindingStreaming([
    sseLine({ response: "ok" }),
    sseLine({ usage: { input_tokens: 41, output_tokens: 7 } }),
    DONE_LINE,
  ]);
  const events = await collectEvents(streamOf(routeOver(binding).runStream(REQUEST)));
  expect(events.at(-1)).toMatchObject({
    type: "done",
    usage: { inputTokens: 41, outputTokens: 7, estimated: false },
  });
});

test("the deployed entrypoint answers runStream across its own service-binding hop", async () => {
  const stub = workerExports.ModelRoute({});
  const refused = await stub.runStream({ messages: [] });
  expect(refused).toEqual({
    ok: false,
    error: { code: "invalid-request", reason: "messages must be a non-empty array" },
  } satisfies ValidationFailure);

  // The test Worker declares no Workers AI binding on purpose (`wrangler.test.jsonc`), so the
  // provider call cannot succeed. What this pins is that a valid request still crosses the RPC
  // boundary as a byte stream carrying one terminal event, rather than throwing out of the hop.
  const outcome = await stub.runStream(REQUEST);
  const events = await collectEvents(streamOf(outcome));
  expect(events).toEqual([{ type: "error", error: { code: "model-unavailable" } }]);
});
