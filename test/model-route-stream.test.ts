import { expect, test } from "vitest";
import type { ModelRouteRequest } from "../src/model-route.js";
import type { ModelStreamInference, StreamingProviderPayload } from "../src/model-route-events.js";
import {
  collectEvents,
  DONE_LINE,
  providerStreamOfLines,
  rawByteStream,
  sseLine,
  streamModelEvents,
} from "./model-route-provider-stream.js";

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

test("sends the whole conversation and its tools to the model, as a stream", async () => {
  const calls: Array<{ model: string; input: StreamingProviderPayload }> = [];

  const ai: ModelStreamInference = {
    run(model, input) {
      calls.push({ model, input });

      return Promise.resolve(rawByteStream([encoder.encode(DONE_LINE)]));
    },
  };

  await collectEvents(streamModelEvents(ai, MULTI_TURN_REQUEST));
  expect(calls).toHaveLength(1);
  expect(calls[0]?.input).toMatchObject({
    messages: MULTI_TURN_REQUEST.messages,
    tools: MULTI_TURN_REQUEST.tools,
    stream: true,
  });
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

test("a stream that completes with no text or tool call is an empty answer, not an error", async () => {
  const provider = providerStreamOfLines([
    sseLine({ choices: [{ delta: { reasoning_content: "thinking" } }] }),
    sseLine({ usage: { prompt_tokens: 5, completion_tokens: 1 } }),
    DONE_LINE,
  ]);

  const events = await collectEvents(streamModelEvents(fakeStreamInference(provider), REQUEST));

  expect(events).toEqual([
    {
      type: "done",
      message: { role: "assistant", content: null, tool_calls: [] },
      usage: { inputTokens: 5, outputTokens: 1, estimated: false },
    },
  ]);
});

test.each([
  { name: "an error object", error: { message: "provider failed", code: 500 } },
  { name: "an error string", error: "provider failed" },
])(
  "$name from the provider keeps the text already sent, then errors once even though [DONE] follows",
  async ({ error }) => {
    const provider = providerStreamOfLines([
      sseLine({ response: "partial" }),
      sseLine({ error }),
      DONE_LINE,
    ]);

    const events = await collectEvents(streamModelEvents(fakeStreamInference(provider), REQUEST));

    expect(events).toEqual([
      { type: "text-delta", delta: "partial" },
      { type: "error", error: { code: "model-unavailable" } },
    ]);
  },
);

type HeldProviderStream = Readonly<{
  stream: ReadableStream<Uint8Array>;
  release: (ending: "close" | "error") => void;
  cancelled: () => boolean;
}>;

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

function eventLine(chunk: Uint8Array | undefined): string {
  return new TextDecoder().decode(chunk);
}

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
