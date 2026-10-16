// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- `savedTranscript` is the parse boundary for Pi's stored messages. Pi owns that schema, so this reader proves only the fields it shows.
import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { defineTaggedUnion } from "foldkit/schema";

/**
 * The transcript as data. Both readers build it: the saved conversation a project selection loads,
 * and the frames a running turn appends (ADR-0037).
 *
 * Every value here came from a repository, a command, or a model, and the view renders each one as
 * a text child. Foldkit builds text children with text nodes, so repository content and model
 * output stay text and cannot become markup this page executes.
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

/** What the page will lay out, whatever the server allowed itself to send. */
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

/** A tool call's one-line summary: its name, then at most 160 characters of its arguments. */
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

/**
 * A result lands in the block its start frame opened. A result whose start frame never arrived
 * still has to be readable, so it gets a block of its own at the end.
 */
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

/** Text a turn streams joins the assistant block it is writing, or opens a new one. */
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
 * The stored messages are Pi's, so this reader takes only what it understands: the text blocks of
 * a message and a tool result's name and output. Anything else is shown as its role and nothing
 * more, because a page that guessed at Pi's schema would break on the next Pi version.
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

function savedTextEntry(message: SavedMessage): TranscriptEntry {
  const body = contentText(message.content);

  if (message.role === "user") {
    return textEntry("user", "you", body);
  }

  if (message.role === "assistant") {
    return textEntry("assistant", "assistant", body);
  }

  return textEntry("system", message.role, body);
}

const ProviderFallback = Schema.Struct({ type: Schema.Literal("provider-fallback") });

/**
 * The model route answered this message from Workers AI because the owner's ChatGPT plan had
 * reached its usage limit; generation 0 records that as a diagnostic on the message (ADR-0047).
 */
function isFallbackAnswer(message: SavedMessage): boolean {
  const diagnostics: unknown = message.diagnostics;

  return (
    message.role === "assistant" &&
    globalThis.Array.isArray(diagnostics) &&
    diagnostics.some((diagnostic) => Schema.is(ProviderFallback)(diagnostic))
  );
}

/**
 * The same rule as {@link withToolResult}, in one pass: a result replaces the latest block with
 * its id, which `toolBlocks` remembers, so a long conversation is not copied once per message.
 */
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
      entries.push(savedTextEntry(message));
      continue;
    }

    const result = savedToolResult(message);
    const index = toolBlocks.get(result.toolCallId) ?? entries.length;

    entries[index] = finishedTool(toolStartEntry(result.toolCallId, result.toolName), result);
    toolBlocks.set(result.toolCallId, index);
  }

  return entries;
}

/** The saved conversation as a transcript, or `None` when the stored text is not a message list. */
export function savedTranscript(conversation: string): Option.Option<readonly TranscriptEntry[]> {
  return Option.flatMap(
    Option.liftThrowable((raw: string): unknown => JSON.parse(raw))(conversation),
    (messages) =>
      globalThis.Array.isArray(messages) ? Option.some(savedEntries(messages)) : Option.none(),
  );
}
