import type * as Schema from "effect/Schema";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import { parseProviderPayload } from "../src/model-route-stream-parse.js";

function parseProviderChunk(payload: Schema.Json) {
  const parsed = parseProviderPayload(JSON.stringify(payload));

  return parsed?.failed === false ? parsed.chunk : undefined;
}

function withoutNegativeZero(value: number): number {
  return value === 0 ? 0 : value;
}

const tokenCandidates = gs.oneOf(
  gs.integers({ minValue: -1_000, maxValue: 1_000_000 }),
  gs.floats({ allowNan: false, allowInfinity: false }),
);

function isTokenCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

const SPELLINGS = [
  ["prompt_tokens", "completion_tokens"],
  ["input_tokens", "output_tokens"],
] as const;

test("reported usage is kept only when both counts are non-negative whole numbers, under either spelling", () => {
  hegel.test((tc) => {
    const [promptKey, completionKey] = tc.draw(gs.sampledFrom([...SPELLINGS]));
    const prompt = withoutNegativeZero(tc.draw(tokenCandidates));
    const completion = withoutNegativeZero(tc.draw(tokenCandidates));

    const { usage } =
      parseProviderChunk({ usage: { [promptKey]: prompt, [completionKey]: completion } }) ?? {};

    expect(usage).toEqual(
      isTokenCount(prompt) && isTokenCount(completion)
        ? { inputTokens: prompt, outputTokens: completion }
        : undefined,
    );
  });
});

type DrawnCall = Readonly<{
  index: number | undefined;
  id: string | undefined;
  name: string | undefined;
  numericName: boolean;
  argumentsDelta: string | undefined;
}>;

type Entry = Readonly<{ wire: unknown; call: DrawnCall | undefined }>;

type DrawnChunk = Readonly<{
  text: string | undefined;
  entries: readonly Entry[];
  spelling: (typeof SPELLINGS)[number];
  counts: readonly [number, number, number] | undefined;
  cached: boolean;
  finish: string | null | undefined;
  dialect: "top-level" | "delta";
}>;

const optionalText = gs.optional(gs.text({ maxSize: 4 })).map((text) => text ?? undefined);

const JUNK_ENTRIES = [5, null, "call", [1]];

function wireCall({ argumentsDelta, id, index, name, numericName }: DrawnCall) {
  const wireName = numericName ? 7 : name;
  const hasFunction = wireName !== undefined || argumentsDelta !== undefined;

  return {
    index,
    id,
    function: hasFunction ? { name: wireName, arguments: argumentsDelta } : undefined,
  };
}

const callRecord = gs.record({
  index: gs.optional(gs.integers({ minValue: 0, maxValue: 9 })).map((index) => index ?? undefined),
  id: optionalText,
  name: optionalText,
  numericName: gs.booleans(),
  argumentsDelta: optionalText,
});

const entry = gs.oneOf(
  gs.sampledFrom(JUNK_ENTRIES).map((junk): Entry => ({ wire: junk, call: undefined })),
  callRecord.map((call): Entry => ({ wire: wireCall(call), call })),
);

const tokenCounts = gs.tuples(
  gs.integers({ minValue: 0, maxValue: 99 }),
  gs.integers({ minValue: 0, maxValue: 99 }),
  tokenCandidates.map(withoutNegativeZero),
);

function drawChunk(tc: hegel.TestCase): DrawnChunk {
  return {
    text: tc.draw(optionalText),
    entries: tc.draw(gs.arrays(entry, { maxSize: 3 })),
    spelling: tc.draw(gs.sampledFrom([...SPELLINGS])),
    counts: tc.draw(gs.optional(tokenCounts).map((counts) => counts ?? undefined)),
    cached: tc.draw(gs.booleans()),
    finish: tc.draw(gs.sampledFrom([undefined, null, "stop", "length", "tool_calls"])),
    dialect: tc.draw(gs.sampledFrom(["top-level", "delta"] as const)),
  };
}

const ERRORS = [
  [undefined, undefined],
  [null, undefined],
  ["", undefined],
  ["model overloaded", { failed: true, detail: "model overloaded" }],
  [
    { code: "rate_limited", type: "server" },
    { failed: true, detail: "rate_limited" },
  ],
  [{ type: "server" }, { failed: true, detail: "server" }],
  [{ message: "no code" }, { failed: true, detail: undefined }],
] as const;

function wirePayload(chunk: DrawnChunk, error: (typeof ERRORS)[number][0]): string {
  const { cached, counts, dialect, finish, spelling, text } = chunk;
  const toolCalls = chunk.entries.map(({ wire }) => wire);
  const [input, output, cachedTokens] = counts ?? [];
  const details = cached ? { cached_tokens: cachedTokens } : undefined;

  const usage =
    counts === undefined
      ? undefined
      : { [spelling[0]]: input, [spelling[1]]: output, prompt_tokens_details: details };

  const delta = dialect === "delta" ? { content: text, tool_calls: toolCalls } : {};
  const top = dialect === "top-level" ? { response: text, tool_calls: toolCalls } : {};
  const hasChoice = dialect === "delta" || finish !== undefined;
  const choices = hasChoice ? [{ delta, finish_reason: finish }] : undefined;

  return JSON.stringify({ ...top, error, choices, usage });
}

function expectedUsage(
  [inputTokens, outputTokens, cachedTokens]: readonly [number, number, number],
  cached: boolean,
) {
  return {
    inputTokens,
    outputTokens,
    cachedTokens: cached && isTokenCount(cachedTokens) ? cachedTokens : undefined,
  };
}

function expectedChunk({ cached, counts, entries, finish, text }: DrawnChunk) {
  const deltas = entries.flatMap(({ call }, position) =>
    call === undefined
      ? []
      : [
          {
            index: call.index ?? position,
            id: call.id,
            name: call.numericName ? undefined : call.name,
            argumentsDelta: call.argumentsDelta,
          },
        ],
  );

  return {
    textDelta: text === "" ? undefined : text,
    toolCallDeltas: deltas.length > 0 ? deltas : undefined,
    usage: counts === undefined ? undefined : expectedUsage(counts, cached),
    truncated: finish === "length" ? true : undefined,
  };
}

test("a provider chunk in either wire dialect parses to the text, tool calls, usage and truncation it carries", () => {
  hegel.test(
    (tc) => {
      const chunk = drawChunk(tc);
      const [error, failure] = tc.draw(gs.sampledFrom(ERRORS));

      expect(parseProviderPayload(wirePayload(chunk, error))).toEqual(
        failure ?? { failed: false, chunk: expectedChunk(chunk) },
      );
    },
    { testCases: 300 },
  );
});

test("a top-level response and tool calls win over the first choice's delta", () => {
  const parsed = parseProviderChunk({
    response: "top",
    tool_calls: [{ id: "top" }],
    choices: [{ delta: { content: "delta", tool_calls: [{ id: "delta" }] } }],
  });

  expect(parsed).toEqual({ textDelta: "top", toolCallDeltas: [{ index: 0, id: "top" }] });
});
