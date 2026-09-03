// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- This file
// is the parse boundary for the saved session document. The document is an opaque string the
// Supervisor stores outside generation state and hands back with the next turn, so a decoded value
// has no proven shape until these functions check it.
import { isBoolean, isPlainObject, isString } from "./plain-values.js";
import type {
  PiAssistantMessage,
  PiContentBlock,
  PiMessage,
  PiToolCall,
  PiUsage,
} from "./workers-ai-adapter.js";

/**
 * Generation 0 owns this schema. The Supervisor stores the document as an opaque string, so the
 * name and version are recorded in the document itself: a later generation that changes the shape
 * changes the version and can tell a document it wrote from one it did not.
 */
const DOCUMENT_HARNESS = "cf-stumble-generation-0";
const DOCUMENT_VERSION = 1;

export type TranscriptToolCall = Readonly<{
  id: string;
  name: string;
  arguments: PiToolCall["arguments"];
}>;

/**
 * One saved conversation step. The transcript keeps what a later turn must send back to the model
 * and nothing else, so no timestamp, usage count, or provider name reaches the stored document.
 */
export type AssistantEntry = Readonly<{
  role: "assistant";
  text: string;
  toolCalls: readonly TranscriptToolCall[];
}>;

export type TranscriptEntry =
  | Readonly<{ role: "user"; text: string }>
  | AssistantEntry
  | Readonly<{
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      text: string;
      isError: boolean;
    }>;

const ZERO_USAGE: PiUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function parseToolCall(value: unknown): TranscriptToolCall | undefined {
  if (!isPlainObject(value)) return undefined;
  const { id, name, arguments: parameters } = value;
  if (!isString(id) || !isString(name) || !isPlainObject(parameters)) return undefined;
  return { id, name, arguments: parameters };
}

function parseAssistantEntry(value: Record<string, unknown>): TranscriptEntry | undefined {
  const { text, toolCalls } = value;
  if (!isString(text) || !Array.isArray(toolCalls)) return undefined;
  const parsed = toolCalls.map((call: unknown) => parseToolCall(call));
  return parsed.every((call): call is TranscriptToolCall => call !== undefined)
    ? { role: "assistant", text, toolCalls: parsed }
    : undefined;
}

function parseToolResultEntry(value: Record<string, unknown>): TranscriptEntry | undefined {
  const { toolCallId, toolName, text, isError } = value;
  if (!isString(toolCallId) || !isString(toolName) || !isString(text) || !isBoolean(isError)) {
    return undefined;
  }
  return { role: "toolResult", toolCallId, toolName, text, isError };
}

function parseEntry(value: unknown): TranscriptEntry | undefined {
  if (!isPlainObject(value)) return undefined;
  switch (value.role) {
    case "user":
      return isString(value.text) ? { role: "user", text: value.text } : undefined;
    case "assistant":
      return parseAssistantEntry(value);
    case "toolResult":
      return parseToolResultEntry(value);
    default:
      return undefined;
  }
}

/**
 * Decode a saved document. `null` or an empty string starts a new conversation; anything this
 * generation did not write returns `undefined` so the facet rejects the turn instead of silently
 * discarding a conversation it cannot read.
 */
export function parseSessionDocument(
  document: string | null,
): readonly TranscriptEntry[] | undefined {
  if (document === null || document === "") return [];

  let decoded: unknown;
  try {
    decoded = JSON.parse(document);
  } catch {
    return undefined;
  }

  if (!isPlainObject(decoded)) return undefined;
  if (decoded.harness !== DOCUMENT_HARNESS || decoded.version !== DOCUMENT_VERSION) {
    return undefined;
  }
  if (!Array.isArray(decoded.entries)) return undefined;

  const entries = decoded.entries.map((entry: unknown) => parseEntry(entry));
  return entries.every((entry): entry is TranscriptEntry => entry !== undefined)
    ? entries
    : undefined;
}

/** Encode the transcript for storage. The same entries always produce the same string. */
export function serializeSessionDocument(entries: readonly TranscriptEntry[]): string {
  return JSON.stringify({
    harness: DOCUMENT_HARNESS,
    version: DOCUMENT_VERSION,
    entries,
  });
}

/** Record an assistant reply as a transcript entry, dropping everything a later turn cannot use. */
export function assistantEntry(message: PiAssistantMessage): AssistantEntry {
  const texts: string[] = [];
  const toolCalls: TranscriptToolCall[] = [];
  for (const block of message.content) {
    if (block.type === "text") texts.push(block.text);
    if (block.type === "toolCall") {
      toolCalls.push({ id: block.id, name: block.name, arguments: block.arguments });
    }
  }

  return { role: "assistant", text: texts.join(""), toolCalls };
}

function assistantMessage(entry: AssistantEntry): PiMessage {
  const content: PiContentBlock[] = [];
  if (entry.text !== "") content.push({ type: "text", text: entry.text });
  for (const call of entry.toolCalls) {
    content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments });
  }

  const message: PiAssistantMessage = {
    role: "assistant",
    content,
    api: "workers-ai",
    provider: "cloudflare-workers-ai",
    model: "model-route",
    usage: ZERO_USAGE,
    stopReason: entry.toolCalls.length > 0 ? "toolUse" : "stop",
    timestamp: 0,
  };
  return message;
}

/** Rebuild the Pi-shaped messages the adapter converts into a model request. */
export function transcriptToPiMessages(entries: readonly TranscriptEntry[]): readonly PiMessage[] {
  return entries.map((entry): PiMessage => {
    switch (entry.role) {
      case "user":
        return { role: "user", content: entry.text, timestamp: 0 };
      case "assistant":
        return assistantMessage(entry);
      case "toolResult":
        return {
          role: "toolResult",
          toolCallId: entry.toolCallId,
          toolName: entry.toolName,
          content: [{ type: "text", text: entry.text }],
          isError: entry.isError,
          timestamp: 0,
        };
      default: {
        const exhaustive: never = entry;
        return exhaustive;
      }
    }
  });
}
