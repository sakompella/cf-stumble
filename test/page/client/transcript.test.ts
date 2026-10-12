import * as Option from "effect/Option";
import { expect, test } from "vitest";
import {
  boundedLines,
  diffLineKind,
  looksLikeDiff,
  savedTranscript,
} from "../../../src/page/client/transcript.js";

test("a saved conversation shows text blocks and tool results, and nothing it cannot read", () => {
  const saved = JSON.stringify([
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [{ type: "text", text: "a" }, { type: "thinking" }, { type: "text", text: "b" }],
    },
    { role: "toolResult", toolCallId: "t", toolName: "read", content: "out", isError: false },
    { role: "custom", content: 5 },
    "not a message",
  ]);

  const transcript = Option.getOrThrow(savedTranscript(saved));

  expect(transcript).toMatchObject([
    { _tag: "Text", role: "user", who: "you", text: "hi" },
    { _tag: "Text", role: "assistant", text: "ab" },
    { _tag: "Tool", summary: "read — done", isFailed: false },
    { _tag: "Text", role: "system", who: "custom", text: "" },
  ]);
  expect(Option.isNone(savedTranscript("{"))).toBe(true);
  expect(Option.isNone(savedTranscript("{}"))).toBe(true);
});

test("output is bounded to what the page lays out", () => {
  const long = "x".repeat(25_000);
  const many = Array.from({ length: 500 }, (_, index) => String(index)).join("\n");

  expect(boundedLines(long)).toMatchObject({ isShortened: true });
  expect(boundedLines(long).lines.join("").length).toBe(20_000);
  expect(boundedLines(many).lines).toHaveLength(400);
  expect(boundedLines("a\nb")).toEqual({ lines: ["a", "b"], isShortened: false });
});

test("a unified diff is recognised and its lines are classified", () => {
  expect(looksLikeDiff("text\n@@ -1 +1 @@\n")).toBe(true);
  expect(looksLikeDiff("plain output")).toBe(false);
  expect(["@@ -1", "+++ b", "--- a", "+x", "-y", " z"].map((line) => diffLineKind(line))).toEqual([
    "hunk",
    "hunk",
    "hunk",
    "added",
    "removed",
    "plain",
  ]);
});
