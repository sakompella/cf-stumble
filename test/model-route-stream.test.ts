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

type HeldProviderStream = Readonly<{
  stream: ReadableStream<Uint8Array>;
  release: (ending: "close" | "error") => void;
  cancelled: () => boolean;
}>;

/** A provider stream that sends `lines`, then stays open until the test releases it. */
function heldProviderStream(lines: readonly string[]): HeldProviderStream {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let wasCancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    start(opened) {
      controller = opened;

      for (const line of lines) opened.enqueue(encoder.encode(line));
    },
    cancel() {
      wasCancelled = true;
    },
  });

  const held: HeldProviderStream = {
    stream,
    release: (ending) => {
      if (ending === "close") controller?.close();
      else controller?.error(new Error("provider connection reset"));
    },
    cancelled: () => wasCancelled,
  };

  return held;
}

/** One event line exactly as the route writes it. */
function eventLine(chunk: Uint8Array | undefined): string {
  return new TextDecoder().decode(chunk);
}

/** The rest of a stream whose reader has already been read from. */
function remainingEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReturnType<typeof collectEvents> {
  return collectEvents(
    new ReadableStream({
      async pull(controller) {
        const next = await reader.read();

        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
    }),
  );
}

test("an event reaches the caller while the provider stream is still open", async () => {
  const provider = heldProviderStream([sseLine({ response: "early" }), DONE_LINE]);
  const reader = streamModelEvents(fakeStreamInference(provider.stream), REQUEST).getReader();

  const first = await reader.read();
  expect(eventLine(first.value)).toBe('{"type":"text-delta","delta":"early"}\n');

  provider.release("close");
  await expect(remainingEvents(reader)).resolves.toMatchObject([{ type: "done" }]);
});

test("a provider stream that fails mid-read keeps the text it sent, then errors once", async () => {
  const provider = heldProviderStream([sseLine({ response: "partial" })]);
  const reader = streamModelEvents(fakeStreamInference(provider.stream), REQUEST).getReader();

  const first = await reader.read();
  expect(eventLine(first.value)).toBe('{"type":"text-delta","delta":"partial"}\n');

  provider.release("error");
  await expect(remainingEvents(reader)).resolves.toEqual([
    { type: "error", error: { code: "model-unavailable" } },
  ]);
});

test("a provider stream past the byte bound ends in one error event and is cancelled", async () => {
  const provider = heldProviderStream([
    sseLine({ response: "start" }),
    `: ${"x".repeat(8_388_608)}\n`,
  ]);

  const events = await collectEvents(
    streamModelEvents(fakeStreamInference(provider.stream), REQUEST),
  );

  expect(events).toEqual([
    { type: "text-delta", delta: "start" },
    { type: "error", error: { code: "model-unavailable" } },
  ]);
  expect(provider.cancelled()).toBe(true);
});

test("a binding call that throws before it returns a Promise becomes one terminal error event", async () => {
  const throwing: ModelStreamInference = {
    run() {
      throw new Error("binding unavailable");
    },
  };

  await expect(collectEvents(streamModelEvents(throwing, REQUEST))).resolves.toEqual([
    { type: "error", error: { code: "model-unavailable" } },
  ]);
});
