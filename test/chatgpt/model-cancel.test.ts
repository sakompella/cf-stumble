import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { chatgptTurn, type ChatGPTCredential } from "../../src/chatgpt/index.js";
import type { ProviderFetch } from "../../src/chatgpt/oauth.js";
import { modelEventStream, type ModelTurn } from "../../src/model-route-turn.js";
import { PROMPTLY_MS, readFirstEvent, REQUEST, until } from "../stream-cancel-fixture.js";
import { ACCESS_ONE, responsesEvent } from "./fixtures.js";

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

test("cancelling the model stream cancels a quiet ChatGPT error body", async () => {
  const seen = { cancelled: false };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("quiet"));
    },
    cancel() {
      seen.cancelled = true;
    },
  });

  const reader = modelEventStream(
    chatgptOnly(() => Promise.resolve(new Response(body, { status: 503 }))),
  ).getReader();

  expect(await until(() => body.locked)).toBeLessThan(PROMPTLY_MS);
  await reader.cancel();

  expect(await until(() => seen.cancelled)).toBeLessThan(PROMPTLY_MS);
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
