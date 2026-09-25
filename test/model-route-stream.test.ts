import { expect, test } from "vitest";
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

/** One SSE line carrying a fragment of one tool call's arguments for slot 0. */
function toolCallChunk(argsFragment: string): string {
  return sseLine({
    tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: argsFragment } }],
  });
}

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
