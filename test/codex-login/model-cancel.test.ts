import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { codexLoginTurn, type CodexLoginCredential } from "../../src/codex-login/index.js";
import type { ProviderFetch } from "../../src/codex-login/oauth.js";
import { modelEventStream, type ModelTurn } from "../../src/model-route-turn.js";
import { PROMPTLY_MS, readFirstEvent, REQUEST, until } from "../stream-cancel-fixture.js";
import { ACCESS_ONE, responsesEvent } from "./fixtures.js";

const CONNECTED: CodexLoginCredential = {
  access: () => Promise.resolve({ kind: "ready", accessToken: ACCESS_ONE }),
  markRefused: () => Promise.resolve(),
  markUsageLimited: () => Promise.resolve(),
};

function codexLoginOnly(fetcher: ProviderFetch): ModelTurn {
  const turn = codexLoginTurn({ credential: CONNECTED, fetcher, model: "gpt-test" }, REQUEST);

  return (emit) =>
    turn(emit).pipe(
      Effect.catchTag(["CodexLoginNotConnected", "CodexLoginUsageLimited"], () =>
        Effect.die(new Error("this test expects a connected credential with no usage limit")),
      ),
    );
}

test("cancelling the model stream before Codex answers aborts the provider fetch", async () => {
  const seen = { aborted: false, asked: false };

  const stream = modelEventStream(
    codexLoginOnly(
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

test("cancelling the model stream cancels a quiet Codex response body", async () => {
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
    codexLoginOnly(() =>
      Promise.resolve(new Response(body, { headers: { "content-type": "text/event-stream" } })),
    ),
  ).getReader();

  await readFirstEvent(reader);
  await reader.cancel();

  expect(await until(() => seen.cancelled)).toBeLessThan(PROMPTLY_MS);
});
