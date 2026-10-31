import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { chatgptTurn, type ChatGPTCredential } from "../src/chatgpt/index.js";
import type { ProviderFetch } from "../src/chatgpt/oauth.js";
import { modelEventStream, type ModelTurn } from "../src/model-route-turn.js";
import type { ModelRouteRequest } from "../src/model-route.js";
import type { ModelStreamInference } from "../src/model-route-events.js";
import { loadFixtureEntrypoint } from "./loaded-fixture.js";
import { ACCESS_ONE, responsesEvent } from "./chatgpt/fixtures.js";
import { sseLine, streamModelEvents } from "./model-route-provider-stream.js";
import type LoadedStreamRelayEntry from "./supervisor/projects/loaded-stream-relay-entry.js";

const REQUEST: ModelRouteRequest = { messages: [{ role: "user", content: "hi" }] };

const PROMPTLY_MS = 5_000;

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

const CONNECTED: ChatGPTCredential = {
  access: () => Promise.resolve({ kind: "ready", accessToken: ACCESS_ONE }),
  markRefused: () => Promise.resolve(),
  markUsageLimited: () => Promise.resolve(),
};

function chatgptOnly(fetcher: ProviderFetch): ModelTurn {
  const turn = chatgptTurn({ credential: CONNECTED, fetcher, model: "gpt-test" }, REQUEST);

  return (emit) =>
    turn(emit).pipe(
      Effect.catchTag(["ChatGPTNotConnected", "ChatGPTUsageLimited"], () =>
        Effect.die(new Error("this test expects a connected credential with no usage limit")),
      ),
    );
}

test("cancelling the model stream before ChatGPT answers aborts the provider fetch", async () => {
  const seen = { aborted: false, asked: false };

  const stream = modelEventStream(
    chatgptOnly(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          seen.asked = true;
          init.signal?.addEventListener("abort", () => {
            seen.aborted = true;
            reject(new Error("aborted"));
          });
        }),
    ),
  );

  expect(await until(() => seen.asked)).toBeLessThan(PROMPTLY_MS);
  await stream.cancel();

  expect(seen.aborted).toBe(true);
});

test("cancelling the model stream cancels a quiet ChatGPT response body", async () => {
  const seen = { cancelled: false };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          responsesEvent({ type: "response.output_text.delta", output_index: 0, delta: "Hi" }),
        ),
      );
    },
    cancel() {
      seen.cancelled = true;
    },
  });

  const reader = modelEventStream(
    chatgptOnly(() =>
      Promise.resolve(new Response(body, { headers: { "content-type": "text/event-stream" } })),
    ),
  ).getReader();

  await readFirstEvent(reader);
  await reader.cancel();

  expect(await until(() => seen.cancelled)).toBeLessThan(PROMPTLY_MS);
});
