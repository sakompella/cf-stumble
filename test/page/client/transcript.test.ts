import * as Option from "effect/Option";
import { expect, test } from "vitest";
import {
  boundedLines,
  diffLineKind,
  looksLikeDiff,
  savedTranscript,
  textEntry,
  TranscriptEntry,
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

/**
 * One saved message of each kind the reader handles, as stored JSON, with each tool call id passed
 * through `id`. Tool `a` gets two results with other messages between them, so the later result
 * replaces the earlier block; `orphan` has no earlier block, and `b` follows the second `a`.
 */
function mixedMessages(id: (toolCallId: string) => string): readonly string[] {
  return [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [{ type: "text", text: "a" }, { type: "thinking" }, { type: "text", text: "b" }],
    },
    { role: "toolResult", toolCallId: id("a"), toolName: "read", content: "one", isError: false },
    { role: "custom", content: 5 },
    "not a message",
    null,
    7,
    {},
    { role: 3, content: "a role that is not text" },
    {
      role: "toolResult",
      toolCallId: id("orphan"),
      toolName: "bash",
      content: [{ type: "text", text: "x" }],
      isError: true,
    },
    { role: "assistant", content: "between" },
    { role: "toolResult", toolCallId: id("a"), toolName: "write", content: "two", isError: true },
    { role: "toolResult", toolCallId: id("b"), toolName: "ls", content: "three" },
    { role: "system" },
  ].map((message) => JSON.stringify(message));
}

function finishedTool(
  toolCallId: string,
  summary: string,
  content: string,
  isFailed: boolean,
): TranscriptEntry {
  return TranscriptEntry.Tool({
    toolCallId,
    summary,
    maybeOutput: Option.some({ content, isServerTruncated: false }),
    isFailed,
  });
}

function mixedTranscript(id: (toolCallId: string) => string): readonly TranscriptEntry[] {
  return [
    textEntry("user", "you", "hi"),
    textEntry("assistant", "assistant", "ab"),
    finishedTool(id("a"), "write — failed", "two", true),
    textEntry("system", "custom", ""),
    finishedTool(id("orphan"), "bash — failed", "x", true),
    textEntry("assistant", "assistant", "between"),
    finishedTool(id("b"), "ls — done", "three", false),
    textEntry("system", "system", ""),
  ];
}

function sameId(toolCallId: string): string {
  return toolCallId;
}

test("a saved conversation keeps its exact entries, and a repeated tool id keeps one block", () => {
  const saved = `[${mixedMessages(sameId).join(",")}]`;

  expect(Option.getOrThrow(savedTranscript(saved))).toStrictEqual(mixedTranscript(sameId));
});

test("a long saved conversation reads as its parts read alone", () => {
  const copies = Array.from(
    { length: 4_000 },
    (_, copy) => (toolCallId: string) => `${toolCallId}-${copy}`,
  );

  const saved = `[${copies.flatMap(mixedMessages).join(",")}]`;

  expect(Option.getOrThrow(savedTranscript(saved))).toStrictEqual(copies.flatMap(mixedTranscript));
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
