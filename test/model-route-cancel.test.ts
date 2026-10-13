import { expect, test } from "vitest";
import {
  streamModelEvents,
  type ModelRouteRequest,
  type ModelStreamInference,
} from "../src/model-route.js";
import { loadFixtureEntrypoint } from "./loaded-fixture.js";
import { sseLine } from "./model-route-provider-stream.js";
import type LoadedStreamRelayEntry from "./supervisor/projects/loaded-stream-relay-entry.js";

/**
 * A generation that stops reading its model stream, because its turn was cancelled, must stop the
 * provider call behind it. The provider is often quiet for a long time before its first token,
 * and Workers RPC tells a stream's source that its reader went away only when the source next
 * writes, so the route cannot wait for the provider's next chunk to find out.
 */

const REQUEST: ModelRouteRequest = { messages: [{ role: "user", content: "hi" }] };

/** Long enough for two keepalives, and far shorter than a quiet provider. */
const PROMPTLY_MS = 5_000;

/** A provider that answers one text chunk and then goes quiet, as one thinking does. */
function quietProvider() {
  const seen = { cancelled: false };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseLine({ response: "Thinking" })));
    },
    cancel() {
      seen.cancelled = true;
    },
  });

  const ai: ModelStreamInference = { run: () => Promise.resolve(stream) };

  return { ai, seen };
}

/** How long `condition` took to hold, or infinity when it did not hold promptly. */
async function until(condition: () => boolean): Promise<number> {
  const started = Date.now();

  while (!condition()) {
    if (Date.now() - started > PROMPTLY_MS) return Number.POSITIVE_INFINITY;

    await scheduler.wait(20);
  }

  return Date.now() - started;
}

async function readFirstEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  const decoder = new TextDecoder();
  let read = "";

  while (!read.includes("text-delta")) {
    const chunk = await reader.read();

    if (chunk.done) throw new Error(`the model stream ended before its first event: ${read}`);

    read += decoder.decode(chunk.value, { stream: true });
  }
}

test("cancelling the model stream cancels the provider's stream", async () => {
  const { ai, seen } = quietProvider();
  const reader = streamModelEvents(ai, REQUEST).getReader();

  await readFirstEvent(reader);
  await reader.cancel();

  expect(await until(() => seen.cancelled)).toBeLessThan(PROMPTLY_MS);
});

test("cancelling the model stream before the provider answers aborts the provider call", async () => {
  const seen = { aborted: false };

  const ai: ModelStreamInference = {
    run: (_model, _input, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          seen.aborted = true;
          reject(new Error("aborted"));
        });
      }),
  };

  const stream = streamModelEvents(ai, REQUEST);

  await stream.cancel();

  expect(seen.aborted).toBe(true);
});

test("a generation that stops reading across Workers RPC cancels a quiet provider", async () => {
  const { ai, seen } = quietProvider();

  const generation = await loadFixtureEntrypoint<LoadedStreamRelayEntry>(
    "loaded-stream-relay-fixture.json",
  );

  const reader = (await generation.relay(streamModelEvents(ai, REQUEST))).getReader();

  await readFirstEvent(reader);
  await reader.cancel();

  expect(await until(() => seen.cancelled)).toBeLessThan(PROMPTLY_MS);
});
