import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import { ResponsesStreamReader } from "../../src/chatgpt/responses.js";
import { ProviderStreamAccumulator } from "../../src/model-route-stream.js";

function streamed(events: readonly object[]) {
  const accumulator = new ProviderStreamAccumulator(() => {});
  const reader = new ResponsesStreamReader(accumulator);
  const ended = events.map((event) => reader.handleLine(`data: ${JSON.stringify(event)}`));

  return { accumulator, reader, ended };
}

const delta = gs.text({ minSize: 1, maxSize: 20 });

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
