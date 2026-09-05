import { expect, test } from "vitest";
import {
  streamModelEvents,
  validateRequest,
  type ModelRouteRequest,
  type ModelStreamEvent,
  type ModelStreamInference,
  type StreamingProviderPayload,
  type ValidationFailure,
} from "../src/model-route.js";

/** A provider stream built from raw byte chunks, so a test controls exactly how bytes split
 * across `ReadableStream` reads — including splitting a multi-byte UTF-8 character in half. */
function rawByteStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[i];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
      i += 1;
    },
  });
}

const encoder = new TextEncoder();

/** One SSE `data:` line carrying a JSON payload, as the classic Workers AI streaming shape sends. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Test-only encoder: builds a wire payload rather than parsing untrusted input.
function sseLine(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n`;
}

const DONE_LINE = "data: [DONE]\n";

function fakeStreamInference(providerStream: ReadableStream<Uint8Array>): ModelStreamInference {
  return {
    run(_model: string, _input: StreamingProviderPayload): Promise<ReadableStream<Uint8Array>> {
      return Promise.resolve(providerStream);
    },
  };
}

async function collectEvents(stream: ReadableStream<Uint8Array>): Promise<ModelStreamEvent[]> {
  const text = await new Response(stream).text();
  const lines = text.split("\n").filter((line) => line !== "");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: every line came from streamModelEvents, which encodes exactly one ModelStreamEvent per line.
  return lines.map((line) => JSON.parse(line) as ModelStreamEvent);
}

const REQUEST: ModelRouteRequest = { messages: [{ role: "user", content: "hi" }] };

test("delivers incremental text deltas and a final assembled message", async () => {
  const provider = rawByteStream([
    encoder.encode(sseLine({ response: "Hel" })),
    encoder.encode(sseLine({ response: "lo" }) + DONE_LINE),
  ]);
  const events = await collectEvents(streamModelEvents(fakeStreamInference(provider), REQUEST));
  expect(events.filter((e) => e.type === "text-delta")).toEqual([
    { type: "text-delta", delta: "Hel" },
    { type: "text-delta", delta: "lo" },
  ]);
  const done = events.at(-1);
  expect(done).toMatchObject({
    type: "done",
    message: { role: "assistant", content: "Hello", tool_calls: [] },
  });
});

test("assembles a tool call whose arguments arrive split across several chunks", async () => {
  const toolCallChunk = (argsFragment: string) =>
    sseLine({
      tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: argsFragment } }],
    });
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
  const splitAt = full.length - 2;
  const provider = rawByteStream([full.slice(0, splitAt), full.slice(splitAt)]);
  const events = await collectEvents(streamModelEvents(fakeStreamInference(provider), REQUEST));
  expect(events.at(-1)).toMatchObject({ type: "done", message: { content: "café" } });
});

test("a provider stream that never sends a terminal marker becomes an error event", async () => {
  const provider = rawByteStream([encoder.encode(sseLine({ response: "partial" }))]);
  const events = await collectEvents(streamModelEvents(fakeStreamInference(provider), REQUEST));
  expect(events).toEqual([
    { type: "text-delta", delta: "partial" },
    { type: "error", error: { code: "model-unavailable" } },
  ]);
});

test("a provider call that rejects before any bytes arrive becomes an error event", async () => {
  const ai: ModelStreamInference = {
    run(): Promise<ReadableStream<Uint8Array>> {
      return Promise.reject(new Error("network reset"));
    },
  };
  const events = await collectEvents(streamModelEvents(ai, REQUEST));
  expect(events).toEqual([{ type: "error", error: { code: "model-unavailable" } }]);
});

test("carries real provider usage through instead of estimating it", async () => {
  const provider = rawByteStream([
    encoder.encode(
      sseLine({ response: "ok" }) +
        sseLine({ usage: { prompt_tokens: 12, completion_tokens: 3 } }) +
        DONE_LINE,
    ),
  ]);
  const events = await collectEvents(streamModelEvents(fakeStreamInference(provider), REQUEST));
  expect(events.at(-1)).toMatchObject({
    type: "done",
    usage: { inputTokens: 12, outputTokens: 3, estimated: false },
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

test("rejects a request whose UTF-8 byte size exceeds 1 MiB even though its string length does not", () => {
  // Each "\u00E9" is 1 UTF-16 code unit (`string.length` counts 600,000) but 2 UTF-8 bytes on the
  // wire (1,200,000 bytes), so a byte-size check catches it while `string.length` would not.
  const content = "\u00E9".repeat(600_000);
  expect(content.length).toBeLessThan(1_048_576);
  const r = validateRequest({ messages: [{ role: "user", content }] });
  expect(r).toEqual({
    ok: false,
    error: { code: "invalid-request", reason: "request exceeds 1 MiB size limit" },
  } satisfies ValidationFailure);
});

test("accepts a request comfortably under the byte-size limit even with multi-byte characters", () => {
  const content = "\u00E9".repeat(1_000);
  expect(validateRequest({ messages: [{ role: "user", content }] })).toEqual({ ok: true });
});
