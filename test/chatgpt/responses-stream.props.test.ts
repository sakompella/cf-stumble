import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { chatgptTurn } from "../../src/chatgpt/index.js";
import { modelEventStream } from "../../src/model-route-turn.js";
import { collectEvents } from "../model-route-provider-stream.js";
import { ACCESS_ONE, fakeCredential, ready, recordingFetch, sseResponse } from "./fixtures.js";

function streamed(events: readonly object[]) {
  const { fetcher } = recordingFetch(() =>
    Promise.resolve(sseResponse(events.map((event) => `data: ${JSON.stringify(event)}\n\n`))),
  );

  const turn = chatgptTurn(
    { credential: fakeCredential([ready(ACCESS_ONE)]), fetcher, model: "gpt-test" },
    { messages: [{ role: "user", content: "hi" }] },
  );

  return collectEvents(
    modelEventStream((emit) =>
      turn(emit).pipe(
        Effect.catchTag(["ChatGPTNotConnected", "ChatGPTUsageLimited"], () =>
          Effect.die(new Error("this test expects a connected credential with no usage limit")),
        ),
      ),
    ),
  );
}

const delta = gs.text({ minSize: 1, maxSize: 20 });

const USAGE_LIMIT_CODES = new Set([
  "rate_limit_exceeded",
  "rate_limit_error",
  "insufficient_quota",
]);

const incompleteReason = gs
  .oneOf(gs.sampledFrom(["max_output_tokens", "content_filter"]), gs.fromRegex("[a-z_]{1,20}"))
  .filter((reason) => !USAGE_LIMIT_CODES.has(reason));

const usage = gs
  .tuples(gs.integers({ minValue: 0, maxValue: 1e6 }), gs.integers({ minValue: 0, maxValue: 1e6 }))
  .map(([inputTokens, outputTokens]) => ({ inputTokens, outputTokens }));

test("a refusal reaches the answer as text, in stream order with any output text", async () => {
  await hegel.testAsync(async (tc) => {
    const parts = tc.draw(gs.arrays(gs.tuples(gs.booleans(), delta), { maxSize: 6 }));
    const refusal = parts.flatMap(([refused, text]) => (refused ? [text] : [])).join("");

    const events = await streamed([
      ...parts.map(([refused, text]) => ({
        type: refused ? "response.refusal.delta" : "response.output_text.delta",
        delta: text,
      })),
      { type: "response.refusal.done", refusal },
      { type: "response.completed", response: {} },
    ]);

    expect(events.flatMap((event) => (event.type === "text-delta" ? [event.delta] : []))).toEqual(
      parts.map(([, text]) => text),
    );
    expect(events.at(-1)).toMatchObject({
      type: "done",
      message: { content: parts.length === 0 ? null : parts.map(([, text]) => text).join("") },
    });
  });
});

test("an incomplete response ends the turn truncated with its usage only when the output limit stopped it", async () => {
  await hegel.testAsync(async (tc) => {
    const reason = tc.draw(incompleteReason);
    const text = tc.draw(delta);
    const reported = tc.draw(usage);

    const events = await streamed([
      { type: "response.output_text.delta", delta: text },
      {
        type: "response.incomplete",
        response: {
          incomplete_details: { reason },
          usage: { input_tokens: reported.inputTokens, output_tokens: reported.outputTokens },
        },
      },
      { type: "response.output_text.delta", delta: "after the end" },
    ]);

    expect(events).toEqual([
      { type: "text-delta", delta: text },
      reason === "max_output_tokens"
        ? {
            type: "done",
            message: { role: "assistant", content: text, tool_calls: [] },
            usage: { ...reported, estimated: false },
            served: { provider: "chatgpt", model: "gpt-test", effort: "medium" },
            truncated: true,
          }
        : { type: "error", error: { code: "model-unavailable", detail: reason } },
    ]);
  });
});
