import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { defineTaggedUnion } from "foldkit/schema";
import type { Conversation } from "./conversation.js";
import type { AssistantMessage, Block, PiMessage } from "./events.js";

const ToolOutput = Schema.Struct({
  content: Schema.String,
  isServerTruncated: Schema.Boolean,
});

type ToolOutput = typeof ToolOutput.Type;

export const TranscriptEntry = defineTaggedUnion({
  Text: { role: Schema.String, who: Schema.String, text: Schema.String },
  Tool: {
    toolCallId: Schema.String,
    summary: Schema.String,
    maybeOutput: Schema.Option(ToolOutput),
    isFailed: Schema.Boolean,
  },
  Terminal: { wording: Schema.String, isProblem: Schema.Boolean },
});

export type TranscriptEntry = typeof TranscriptEntry.Type;

export type ToolEntry = typeof TranscriptEntry.Tool.Type;

const DISPLAY_MAX_CHARACTERS = 20_000;

const DISPLAY_MAX_LINES = 400;

export type BoundedLines = Readonly<{ lines: readonly string[]; isShortened: boolean }>;

export function boundedLines(value: string): BoundedLines {
  const shortened = value.slice(0, DISPLAY_MAX_CHARACTERS);
  const lines = shortened.split("\n");
  const kept = lines.slice(0, DISPLAY_MAX_LINES);

  return {
    lines: kept,
    isShortened: kept.length < lines.length || shortened.length < value.length,
  };
}

export function looksLikeDiff(value: string): boolean {
  return /^(diff --git |@@ |\+\+\+ |--- )/mu.test(value);
}

export function diffLineKind(line: string): "hunk" | "added" | "removed" | "plain" {
  if (line.startsWith("@@") || line.startsWith("+++") || line.startsWith("---")) {
    return "hunk";
  }

  if (line.startsWith("+")) {
    return "added";
  }

  return line.startsWith("-") ? "removed" : "plain";
}

export function toolSummaryText(toolName: string, argumentsJson: string): string {
  return argumentsJson === "" || argumentsJson === "{}"
    ? toolName
    : `${toolName} ${argumentsJson.slice(0, 160)}`;
}

export function textEntry(role: string, who: string, text: string): TranscriptEntry {
  return TranscriptEntry.Text({ role, who, text });
}

export function toolStartEntry(toolCallId: string, summary: string): ToolEntry {
  return TranscriptEntry.Tool({
    toolCallId,
    summary,
    maybeOutput: Option.none(),
    isFailed: false,
  });
}

export const OutboxItem = Schema.Struct({
  requestId: Schema.String,
  text: Schema.String,
  maybeSubmissionId: Schema.Option(Schema.Number),
});

export type OutboxItem = typeof OutboxItem.Type;

function blocksText(blocks: readonly Block[]): string {
  return blocks.flatMap((block) => ("text" in block ? [block.text] : [])).join("");
}

function finishedTool(
  tool: ToolEntry,
  result: Readonly<{ toolName: string; text: string; isError: boolean }>,
): ToolEntry {
  return TranscriptEntry.Tool({
    toolCallId: tool.toolCallId,
    summary: `${result.toolName}${result.isError ? " — failed" : " — done"}`,
    maybeOutput: Option.some({ content: result.text, isServerTruncated: false }),
    isFailed: result.isError,
  });
}

function isFallbackAnswer(message: AssistantMessage): boolean {
  return (
    message.diagnostics?.some((diagnostic) => diagnostic.type === "provider-fallback") === true
  );
}

function assistantEntries(message: AssistantMessage): readonly TranscriptEntry[] {
  const text = blocksText(message.content);

  return [
    ...(isFallbackAnswer(message)
      ? [textEntry("system", "notice", "ChatGPT usage limit reached; answered with Workers AI")]
      : []),
    ...(text === "" ? [] : [textEntry("assistant", "assistant", text)]),
    ...message.content.flatMap((block) =>
      block.type === "toolCall" && "id" in block
        ? [toolStartEntry(block.id, toolSummaryText(block.name, JSON.stringify(block.arguments)))]
        : [],
    ),
    ...(message.stopReason === "aborted"
      ? [TranscriptEntry.Terminal({ wording: "cancelled", isProblem: true })]
      : []),
    ...(message.stopReason === "error"
      ? [
          TranscriptEntry.Terminal({
            wording: `failed: ${message.errorMessage ?? "model error"}`,
            isProblem: true,
          }),
        ]
      : []),
  ];
}

function withLiveOutput(entry: TranscriptEntry, conversation: Conversation): TranscriptEntry {
  if (entry._tag !== "Tool" || Option.isSome(entry.maybeOutput)) {
    return entry;
  }

  const output = conversation.tools.find((slot) => slot.callId === entry.toolCallId)?.output;

  return output === undefined
    ? entry
    : { ...entry, maybeOutput: Option.some({ content: output, isServerTruncated: false }) };
}

export function transcriptOf(
  conversation: Conversation,
  outbox: readonly OutboxItem[],
): readonly TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const toolBlocks = new Map<string, number>();

  const add = (message: PiMessage) => {
    if ("stopReason" in message) {
      for (const entry of assistantEntries(message)) {
        if (entry._tag === "Tool") {
          toolBlocks.set(entry.toolCallId, entries.length);
        }

        entries.push(entry);
      }

      return;
    }

    if ("toolCallId" in message) {
      const index = toolBlocks.get(message.toolCallId) ?? entries.length;
      const start = toolStartEntry(message.toolCallId, message.toolName);

      entries[index] = finishedTool(start, {
        toolName: message.toolName,
        text: blocksText(message.content),
        isError: message.isError,
      });
      toolBlocks.set(message.toolCallId, index);

      return;
    }

    if ("content" in message) {
      const { content } = message;

      entries.push(
        textEntry("user", "you", Predicate.isString(content) ? content : blocksText(content)),
      );
    }
  };

  for (const entry of conversation.entries) {
    entry.model?.forEach(add);
  }

  Option.map(conversation.maybePartial, add);

  return [
    ...entries.map((entry) => withLiveOutput(entry, conversation)),
    ...outbox.map((item) =>
      textEntry(
        "user",
        Option.isSome(item.maybeSubmissionId) ? "you · queued" : "you · sending",
        item.text,
      ),
    ),
  ];
}
