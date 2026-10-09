import { expect, test } from "vitest";
import { byteChunkStream } from "./byte-stream-fixture.js";
import {
  streamModelEvents,
  type ModelRouteRequest,
  type ModelStreamInference,
  type StreamingProviderPayload,
} from "../src/model-route.js";
import { collectEvents, DONE_LINE, rawByteStream, sseLine } from "./model-route-provider-stream.js";

const encoder = new TextEncoder();

function fakeStreamInference(providerStream: ReadableStream<Uint8Array>): ModelStreamInference {
  return {
    run(_model: string, _input: StreamingProviderPayload): Promise<ReadableStream<Uint8Array>> {
      return Promise.resolve(providerStream);
    },
  };
}

const REQUEST: ModelRouteRequest = { messages: [{ role: "user", content: "hi" }] };

const MULTI_TURN_REQUEST: ModelRouteRequest = {
  messages: [
    { role: "system", content: "You are a coding assistant." },
    { role: "user", content: "Read file.txt" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_abc123", function: { name: "read_file", arguments: '{"path":"file.txt"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_abc123", content: "file contents here" },
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    },
  ],
};

/** One SSE line carrying a fragment of one tool call's arguments for slot 0. */
function toolCallChunk(argsFragment: string): string {
  return sseLine({
    tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: argsFragment } }],
  });
}

test("delivers byte chunks in order and reports exhaustion without reporting cancellation", async () => {
  const chunks = [new Uint8Array([1]), new Uint8Array([2, 3])];
  const exhausted: string[] = [];

  const onExhausted = (): void => {
    exhausted.push("exhausted");
  };

  const reader = byteChunkStream(chunks, onExhausted).getReader();

  expect(await reader.read()).toEqual({ value: chunks[0], done: false });
  expect(exhausted).toEqual([]);
  expect(await reader.read()).toEqual({ value: chunks[1], done: false });
  expect(await reader.read()).toEqual({ value: undefined, done: true });
  expect(exhausted).toEqual(["exhausted"]);

  const cancelled: string[] = [];

  const onCancelledExhausted = (): void => {
    cancelled.push("exhausted");
  };

  const cancelledReader = byteChunkStream(chunks, onCancelledExhausted).getReader();

  await cancelledReader.cancel();
  expect(cancelled).toEqual([]);
});

test("sends the whole conversation and its tools to the one fixed model", async () => {
  const calls: Array<{ model: string; input: StreamingProviderPayload }> = [];

  const ai: ModelStreamInference = {
    run(model, input) {
      calls.push({ model, input });

      return Promise.resolve(rawByteStream([encoder.encode(DONE_LINE)]));
    },
  };

  await collectEvents(streamModelEvents(ai, MULTI_TURN_REQUEST));
  expect(calls).toEqual([
    {
      model: "@cf/zai-org/glm-5.3-flash",
      input: {
        messages: MULTI_TURN_REQUEST.messages,
        tools: MULTI_TURN_REQUEST.tools,
        reasoning_effort: "low",
        max_tokens: 4096,
        stream: true,
      },
    },
  ]);
});

test("assembles a tool call whose arguments arrive split across several chunks", async () => {
  const provider = rawByteStream([
    encoder.encode(toolCallChunk('{"cm')),
    encoder.encode(toolCallChunk('d":"l')),
    encoder.encode(toolCallChunk('s"}') + DONE_LINE),
  ]);

  const events = await collectEvents(streamModelEvents(fakeStreamInference(provider), REQUEST));
  const deltas = events.filter((e) => e.type === "tool-call-delta");
  expect(deltas).toHaveLength(3);
  const done = events.at(-1);
  expect(done).toMatchObject({
    type: "done",
    message: {
      content: null,
      tool_calls: [{ id: "call_1", function: { name: "bash", arguments: '{"cmd":"ls"}' } }],
    },
  });
});

test("reassembles a multi-byte UTF-8 character split across two raw byte chunks", async () => {
  const full = encoder.encode(sseLine({ response: "café" }) + DONE_LINE);
  // "café" ends with the two-byte UTF-8 sequence for "é" (0xC3 0xA9); split one byte into it so
  // neither chunk holds a complete character on its own.
  const splitAt = full.indexOf(0xc3) + 1;
  expect(full[splitAt]).toBeGreaterThanOrEqual(0x80);
  expect(full[splitAt]).toBeLessThanOrEqual(0xbf);
  const provider = rawByteStream([full.slice(0, splitAt), full.slice(splitAt)]);
  const events = await collectEvents(streamModelEvents(fakeStreamInference(provider), REQUEST));
  expect(events.at(-1)).toMatchObject({ type: "done", message: { content: "café" } });
});

test("estimates non-zero usage, and marks it as an estimate, when the provider reports none", async () => {
  const provider = rawByteStream([
    encoder.encode(sseLine({ response: "hello there" }) + DONE_LINE),
  ]);

  const events = await collectEvents(streamModelEvents(fakeStreamInference(provider), REQUEST));
  const done = events.at(-1);
  expect(done?.type).toBe("done");

  if (done?.type !== "done") throw new Error("expected done");
  expect(done.usage.estimated).toBe(true);
  expect(done.usage.inputTokens).toBeGreaterThan(0);
  expect(done.usage.outputTokens).toBeGreaterThan(0);
});
