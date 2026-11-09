import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import { ResponsesStreamReader } from "../../src/chatgpt/responses.js";
import { ProviderStreamAccumulator } from "../../src/model-route-stream.js";

function streamed(events: readonly object[]) {
  const accumulator = new ProviderStreamAccumulator(() => {});
  const reader = new ResponsesStreamReader(accumulator);
  const ended = events.map((event) => reader.handleEvent(JSON.stringify(event)));

  return { accumulator, reader, ended };
}

const delta = gs.text({ minSize: 1, maxSize: 20 });

const usage = gs
  .tuples(gs.integers({ minValue: 0, maxValue: 1e6 }), gs.integers({ minValue: 0, maxValue: 1e6 }))
  .map(([inputTokens, outputTokens]) => ({ inputTokens, outputTokens }));

test("a refusal reaches the answer as text, in stream order with any output text", () => {
  hegel.test((tc) => {
    const parts = tc.draw(gs.arrays(gs.tuples(gs.booleans(), delta), { maxSize: 6 }));
    const refusal = parts.flatMap(([refused, text]) => (refused ? [text] : [])).join("");

    const { accumulator, reader } = streamed([
      ...parts.map(([refused, text]) => ({
        type: refused ? "response.refusal.delta" : "response.output_text.delta",
        delta: text,
      })),
      { type: "response.refusal.done", refusal },
      { type: "response.completed", response: {} },
    ]);

    expect(reader.failure).toBeUndefined();
    expect(accumulator.result().content).toBe(
      parts.length === 0 ? null : parts.map(([, text]) => text).join(""),
    );
  });
});

test("an incomplete response ends the turn truncated with its usage only when the output limit stopped it", () => {
  hegel.test((tc) => {
    const reason = tc.draw(
      gs.oneOf(gs.sampledFrom(["max_output_tokens", "content_filter"]), gs.text({ maxSize: 20 })),
    );

    const text = tc.draw(delta);
    const reported = tc.draw(usage);

    const { accumulator, reader, ended } = streamed([
      { type: "response.output_text.delta", delta: text },
      {
        type: "response.incomplete",
        response: {
          incomplete_details: { reason },
          usage: { input_tokens: reported.inputTokens, output_tokens: reported.outputTokens },
        },
      },
    ]);

    const lengthStop = reason === "max_output_tokens";

    expect(ended).toEqual([false, true]);
    expect(reader.failure === undefined).toBe(lengthStop);
    expect(accumulator.truncated).toBe(lengthStop);
    expect(accumulator.usage()).toEqual(lengthStop ? reported : undefined);
    expect(accumulator.result().content).toBe(text);
  });
});
