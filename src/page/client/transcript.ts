// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- `savedTranscript` is the parse boundary for Pi's stored messages. Pi owns that schema, so this reader proves only the fields it shows.
import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { defineTaggedUnion } from "foldkit/schema";

/**
 * Foldkit builds text children with text nodes, so repository content and model output stay text and
 * cannot become markup this page executes.
 */

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
  Diff: { content: Schema.String, isTruncated: Schema.Boolean },
  DiffUnavailable: { detail: Schema.String },
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

export type ToolResult = Readonly<{
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
  isTruncated: boolean;
}>;

function finishedTool(tool: ToolEntry, result: ToolResult): ToolEntry {
  return TranscriptEntry.Tool({
    toolCallId: tool.toolCallId,
    summary: `${result.toolName}${result.isError ? " — failed" : " — done"}`,
    maybeOutput: Option.some({ content: result.content, isServerTruncated: result.isTruncated }),
    isFailed: result.isError,
  });
}

/** A result whose start frame never arrived gets a block of its own at the end. */
export function withToolResult(
  transcript: readonly TranscriptEntry[],
  result: ToolResult,
): readonly TranscriptEntry[] {
  const maybeIndex = Array.findLastIndex(
    transcript,
    (entry) => entry._tag === "Tool" && entry.toolCallId === result.toolCallId,
  );

  if (Option.isNone(maybeIndex)) {
    return [
      ...transcript,
      finishedTool(toolStartEntry(result.toolCallId, result.toolName), result),
    ];
  }

  return transcript.map((entry, index) =>
    index === maybeIndex.value && entry._tag === "Tool" ? finishedTool(entry, result) : entry,
  );
}

export function withAssistantText(
  transcript: readonly TranscriptEntry[],
  isAssistantOpen: boolean,
  text: string,
): readonly TranscriptEntry[] {
  const maybeLast = Array.last(transcript);

  if (isAssistantOpen && Option.isSome(maybeLast) && maybeLast.value._tag === "Text") {
    const last = maybeLast.value;

    return [...transcript.slice(0, -1), textEntry(last.role, last.who, `${last.text}${text}`)];
  }

  return [...transcript, textEntry("assistant", "assistant", text)];
}

/**
 * Anything the reader does not understand shows as its role only, since a page that guessed at Pi's
 * schema would break on the next Pi version.
 */
const SavedTextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

function contentText(content: unknown): string {
  if (Predicate.isString(content)) {
    return content;
  }

  if (!globalThis.Array.isArray(content)) {
    return "";
  }

  const blocks: readonly unknown[] = content;

  return blocks.flatMap((block) => (Schema.is(SavedTextBlock)(block) ? [block.text] : [])).join("");
}

const SavedMessage = Schema.Struct({
  role: Schema.String,
  content: Schema.optional(Schema.Unknown),
  toolCallId: Schema.optional(Schema.Unknown),
  toolName: Schema.optional(Schema.Unknown),
  isError: Schema.optional(Schema.Unknown),
  diagnostics: Schema.optional(Schema.Unknown),
});

type SavedMessage = typeof SavedMessage.Type;

function asText(value: unknown): string {
  return Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)
    ? String(value)
    : "";
}

function savedToolResult(message: SavedMessage): ToolResult {
  return {
    toolCallId: asText(message.toolCallId),
    toolName: asText(message.toolName),
    content: contentText(message.content),
    isError: message.isError === true,
    isTruncated: false,
  };
}

function savedTextEntry(message: SavedMessage): Option.Option<TranscriptEntry> {
  const body = contentText(message.content);

  if (message.role === "user") {
    return Option.some(textEntry("user", "you", body));
  }

  if (message.role === "assistant") {
    return body === "" ? Option.none() : Option.some(textEntry("assistant", "assistant", body));
  }

  return Option.some(textEntry("system", message.role, body));
}

const ProviderFallback = Schema.Struct({ type: Schema.Literal("provider-fallback") });

/** The model route records a Workers AI fallback as a diagnostic on the message. */
function isFallbackAnswer(message: SavedMessage): boolean {
  const diagnostics: unknown = message.diagnostics;

  return (
    message.role === "assistant" &&
    globalThis.Array.isArray(diagnostics) &&
    diagnostics.some((diagnostic) => Schema.is(ProviderFallback)(diagnostic))
  );
}

/** One pass; `toolBlocks` remembers each block by id, so a long conversation is not copied per message. */
function savedEntries(messages: readonly unknown[]): readonly TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const toolBlocks = new Map<string, number>();

  for (const message of messages) {
    if (!Schema.is(SavedMessage)(message)) {
      continue;
    }

    if (isFallbackAnswer(message)) {
      entries.push(
        textEntry("system", "notice", "ChatGPT usage limit reached; answered with Workers AI"),
      );
    }

    if (message.role !== "toolResult") {
      entries.push(...Option.toArray(savedTextEntry(message)));
      continue;
    }

    const result = savedToolResult(message);
    const index = toolBlocks.get(result.toolCallId) ?? entries.length;

    entries[index] = finishedTool(toolStartEntry(result.toolCallId, result.toolName), result);
    toolBlocks.set(result.toolCallId, index);
  }

  return entries;
}

export function savedTranscript(conversation: string): Option.Option<readonly TranscriptEntry[]> {
  return Option.flatMap(
    Option.liftThrowable((raw: string): unknown => JSON.parse(raw))(conversation),
    (messages) =>
      globalThis.Array.isArray(messages) ? Option.some(savedEntries(messages)) : Option.none(),
  );
}
