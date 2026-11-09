import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";
import type { ModelRouteRequest } from "../src/model-route-wire/request.js";
import type { ModelStreamEvent } from "../src/model-route-wire/events.js";
import {
  collectEvents,
  DONE_LINE,
  rawByteStream,
  sseLine,
  streamModelEvents,
} from "./model-route-provider-stream.js";

const REQUEST: ModelRouteRequest = { messages: [{ role: "user", content: "hi" }] };

const deltaText = gs.text({ alphabet: 'aé日🙂"\\\n', minSize: 1, maxSize: 6 });

const NOISE = [
  "event: ping\n",
  ": comment\n",
  "data: {not json\n\n",
  sseLine("a bare string"),
  sseLine({ unknown: 1 }),
  "\n",
];

type ToolCallModel = { id: string; name: string; fragments: string[] };

function cutAt(bytes: Uint8Array, offsets: readonly number[]): Uint8Array[] {
  const points = [
    ...new Set([0, ...offsets.map((offset) => offset % (bytes.length + 1)), bytes.length]),
  ].toSorted((a, b) => a - b);

  return points.slice(1).map((end, index) => bytes.slice(points[index], end));
}

function eventsOf(chunks: readonly Uint8Array[]): Promise<ModelStreamEvent[]> {
  return collectEvents(
    streamModelEvents({ run: () => Promise.resolve(rawByteStream(chunks)) }, REQUEST),
  );
}

function providerLines(
  tc: hegel.TestCase,
  deltas: readonly string[],
  calls: readonly ToolCallModel[],
): string {
  const lines: string[] = [];

  const withNoise = (line: string) => {
    if (tc.draw(gs.booleans())) lines.push(tc.draw(gs.sampledFrom(NOISE)));
    lines.push(line);
  };

  for (const delta of deltas) {
    withNoise(
      sseLine(
        tc.draw(gs.booleans()) ? { response: delta } : { choices: [{ delta: { content: delta } }] },
      ),
    );
  }

  for (const [index, call] of calls.entries()) {
    withNoise(sseLine({ tool_calls: [{ index, id: call.id, function: { name: call.name } }] }));

    for (const fragment of call.fragments) {
      withNoise(sseLine({ tool_calls: [{ index, function: { arguments: fragment } }] }));
    }
  }

  withNoise(DONE_LINE);

  return lines.join("");
}

test("the events of a provider stream do not depend on where its bytes are cut", async () => {
  await hegel.testAsync(
    async (tc) => {
      const deltas = tc.draw(gs.arrays(deltaText, { maxSize: 5 }));

      const calls: ToolCallModel[] = tc
        .draw(gs.arrays(gs.arrays(deltaText, { minSize: 1, maxSize: 3 }), { maxSize: 2 }))
        .map((fragments, index) => ({ id: `call_${index}`, name: `tool${index}`, fragments }));

      const lines = providerLines(tc, deltas, calls);
      const unterminated = tc.draw(gs.booleans());
      const bytes = new TextEncoder().encode(unterminated ? lines.slice(0, -1) : lines);

      const offsets = tc.draw(
        gs.arrays(gs.integers({ minValue: 0, maxValue: 4_096 }), { maxSize: 8 }),
      );

      const whole = await eventsOf([bytes]);
      const cut = await eventsOf(cutAt(bytes, offsets));

      expect(cut).toEqual(whole);
      expect(cut.flatMap((event) => (event.type === "text-delta" ? [event.delta] : []))).toEqual(
        deltas,
      );
      expect(cut.filter((event) => event.type === "tool-call-delta")).toHaveLength(
        calls.length + calls.reduce((total, call) => total + call.fragments.length, 0),
      );
      expect(cut.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(
        1,
      );
      expect(cut.at(-1)).toMatchObject(
        unterminated
          ? {
              type: "error",
              error: {
                code: "model-unavailable",
                detail: "the stream ended without a terminal event",
              },
            }
          : {
              type: "done",
              message: {
                content: deltas.length === 0 ? null : deltas.join(""),
                tool_calls: calls.map((call) => ({
                  id: call.id,
                  function: { name: call.name, arguments: call.fragments.join("") },
                })),
              },
            },
      );
    },
    { testCases: 200 },
  );
});
