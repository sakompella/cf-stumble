import * as Option from "effect/Option";
import { expect, test } from "vitest";
import { EMPTY_CONVERSATION, type Conversation } from "../../../src/page/client/conversation.js";
import type { Entry, PiMessage } from "../../../src/page/client/agent-event.js";
import {
  boundedLines,
  diffLineKind,
  looksLikeDiff,
  transcriptOf,
} from "../../../src/page/client/transcript.js";

function conversationOf(...messages: readonly PiMessage[]): Conversation {
  const entries: Entry[] = messages.map((message, index) => ({
    id: index + 1,
    kind: "pi.test",
    model: [message],
  }));

  return { ...EMPTY_CONVERSATION, entries };
}

function answer(
  content: Extract<PiMessage, { stopReason: string }>["content"],
  stopReason = "stop",
) {
  return { role: "assistant", content, stopReason } as const;
}

const toolCall = { type: "toolCall", id: "t", name: "read", arguments: { path: "a" } } as const;

const toolResult = {
  role: "toolResult",
  toolCallId: "t",
  toolName: "read",
  content: [{ type: "text", text: "out" }],
  isError: false,
} as const;

test("a conversation shows its text, fills each tool call's block with its result, and skips the rest", () => {
  const conversation = conversationOf(
    { role: "user", content: "hi" },
    { role: "system" },
    answer([
      { type: "text", text: "a" },
      { type: "thinking" },
      { type: "text", text: "b" },
      toolCall,
    ]),
    toolResult,
  );

  expect(transcriptOf(conversation, [])).toMatchObject([
    { _tag: "Text", role: "user", who: "you", text: "hi" },
    { _tag: "Text", role: "assistant", text: "ab" },
    { _tag: "Tool", toolCallId: "t", summary: "read — done", isFailed: false },
  ]);
});

test("an answer that holds only tool calls adds no empty entry, and a running call shows its live output", () => {
  const conversation: Conversation = {
    ...conversationOf({ role: "user", content: "hi" }, answer([toolCall], "toolUse")),
    tools: [{ callId: "t", name: "read", status: "running", output: "so far" }],
  };

  expect(transcriptOf(conversation, [])).toMatchObject([
    { _tag: "Text", role: "user" },
    {
      _tag: "Tool",
      summary: 'read {"path":"a"}',
      maybeOutput: Option.some({ content: "so far", isServerTruncated: false }),
    },
  ]);
});

test("an answer Workers AI gave after ChatGPT's usage limit is preceded by a notice", () => {
  const conversation = conversationOf({
    ...answer([{ type: "text", text: "from Workers AI" }]),
    diagnostics: [{ type: "provider-fallback" }],
  });

  expect(transcriptOf(conversation, [])).toMatchObject([
    {
      role: "system",
      who: "notice",
      text: "ChatGPT usage limit reached; answered with Workers AI",
    },
    { role: "assistant", text: "from Workers AI" },
  ]);
});

test("an aborted or failed answer ends with what stopped it", () => {
  const conversation = conversationOf(answer([], "aborted"), {
    ...answer([], "error"),
    errorMessage: "model-call-limit",
  });

  expect(transcriptOf(conversation, [])).toMatchObject([
    { _tag: "Terminal", wording: "cancelled", isProblem: true },
    { _tag: "Terminal", wording: "failed: model-call-limit", isProblem: true },
  ]);
});

test("the streaming answer and the messages this page has not seen placed follow the entries", () => {
  const conversation: Conversation = {
    ...conversationOf({ role: "user", content: "first" }),
    maybePartial: Option.some(answer([{ type: "text", text: "Hel" }], "pending")),
  };

  const outbox = [
    { requestId: "a", text: "queued one", maybeSubmissionId: Option.some(9) },
    { requestId: "b", text: "sending one", maybeSubmissionId: Option.none() },
  ];

  expect(transcriptOf(conversation, outbox)).toMatchObject([
    { who: "you", text: "first" },
    { who: "assistant", text: "Hel" },
    { who: "you · queued", text: "queued one" },
    { who: "you · sending", text: "sending one" },
  ]);
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
