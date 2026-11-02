import { expect, test } from "vitest";
import type { ModelStreamInference } from "../src/model-route-events.js";
import { loadFixtureEntrypoint } from "./loaded-fixture.js";
import { sseLine, streamModelEvents } from "./model-route-provider-stream.js";
import { PROMPTLY_MS, readFirstEvent, REQUEST, until } from "./stream-cancel-fixture.js";
import type LoadedStreamRelayEntry from "./supervisor/projects/loaded-stream-relay-entry.js";

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
