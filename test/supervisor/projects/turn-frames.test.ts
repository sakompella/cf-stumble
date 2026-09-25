import { expect, test } from "vitest";

import { parseFacetFrameLine } from "../../../src/supervisor/projects/turn-frames.js";

const malformed = { kind: "invalid", problem: "malformed-frame" } as const;

test.each([
  ["a malformed line", "{not json"],
  ["a frame of a kind the Supervisor does not know", JSON.stringify({ kind: "invented" })],
  [
    "a frame missing a field its kind declares",
    JSON.stringify({ kind: "tool-result", toolCallId: "call-1", toolName: "bash" }),
  ],
  [
    "a diff frame that does not say whether it was cut",
    JSON.stringify({ kind: "diff", content: "diff --git a/a b/a" }),
  ],
])("returns malformed-frame for %s", (_description, line) => {
  expect(parseFacetFrameLine(line)).toEqual(malformed);
});

test("drops fields a generation adds to a forwarded frame", () => {
  expect(
    parseFacetFrameLine(
      JSON.stringify({ kind: "text", text: "hello", injected: "not-for-browser" }),
    ),
  ).toEqual({ kind: "forwarded", frame: { kind: "text", text: "hello" } });
});
