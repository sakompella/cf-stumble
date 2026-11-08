import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import type { ModelCapability } from "../../../src/facet/generation-1/capabilities.js";
import type { ModelStreamEvent } from "../../../src/model-route-events.js";
import { GO, NO_USAGE, streamThroughProvider } from "./scripted-route.js";

const encoder = new TextEncoder();

function drawEvents(tc: hegel.TestCase): ModelStreamEvent[] {
  const deltas = tc.draw(
    gs.arrays(
      gs.oneOf(
        gs
          .sampledFrom(["a", "\u00E9", "\u20AC", "\u{1F600}", "\n"])
          .map((delta): ModelStreamEvent => ({ type: "text-delta", delta })),
        gs.integers({ minValue: 0, maxValue: 2 }).map((index): ModelStreamEvent => ({
          type: "tool-call-delta",
          delta: { index, id: `call_${index}`, name: "bash", argumentsDelta: "{}" },
        })),
      ),
      { minSize: 1, maxSize: 7 },
    ),
  );

  const done: ModelStreamEvent = {
    type: "done",
    message: { role: "assistant", content: null, tool_calls: [] },
    usage: NO_USAGE,
  };

  return [...deltas, done];
}

function drawCuts(tc: hegel.TestCase, length: number): number[] {
  const cuts = tc.draw(
    gs.arrays(gs.integers({ minValue: 0, maxValue: length }), { minSize: 0, maxSize: 6 }),
  );

  return [...new Set(cuts)].toSorted((left, right) => left - right);
}

function readsOf(bytes: Uint8Array, cuts: readonly number[]): Uint8Array[] {
  const edges = [0, ...cuts, bytes.length];

  return edges.slice(1).map((end, index) => bytes.slice(edges[index], end));
}

async function replyTo(reads: readonly Uint8Array[]) {
  const capability: ModelCapability = {
    runStream: () =>
      Promise.resolve(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const read of reads) controller.enqueue(read);
            controller.close();
          },
        }),
      ),
  };

  const reply = streamThroughProvider(capability, GO);
  const events: string[] = [];

  for await (const event of reply) {
    events.push("delta" in event ? `${event.type}:${event.delta}` : event.type);
  }

  const { timestamp: _timestamp, durationMs: _durationMs, ...message } = await reply.result();

  return { events, message };
}

test("a reply is the same wherever the route's bytes are cut into reads", async () => {
  await hegel.testAsync(
    async (tc) => {
      const events = drawEvents(tc);
      const bytes = encoder.encode(events.map((event) => `${JSON.stringify(event)}\n`).join(""));
      const cuts = drawCuts(tc, bytes.length);

      expect(await replyTo(readsOf(bytes, cuts)), `cuts at ${cuts.join(",")}`).toEqual(
        await replyTo([bytes]),
      );
    },
    { testCases: 50 },
  );
});
