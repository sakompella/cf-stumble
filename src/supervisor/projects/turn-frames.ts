// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- This module is the parse boundary for a generation's turn stream. A generation is mutable harness code, so nothing it writes into a frame has a proven shape until these functions prove it.
import { isRecord } from "../../untrusted.js";

/** Nothing a generation emits reaches a browser unparsed, and its Pi state never does. */

/**
 * A line past the terminal bound ends the turn as an invalid stream rather than growing a buffer
 * until the isolate dies. A progress frame past the progress bound is dropped. The terminal bound
 * stays below Cloudflare's 2 MB Durable Object string, BLOB, and row cap, so a conversation the
 * store could not hold ends the turn as `oversized-frame` instead of failing the save.
 */
export const TURN_PROGRESS_FRAME_MAX_BYTES = 262_144;

export const TURN_TERMINAL_FRAME_MAX_BYTES = 1_835_008;

export type TurnStreamProblem = "malformed-frame" | "oversized-frame" | "missing-terminal-frame";

export type FacetTerminalFrame =
  | Readonly<{ kind: "completed"; messages: readonly unknown[] }>
  | Readonly<{
      kind: "failed";
      code: "model-call-limit" | "model-error";
      messages: readonly unknown[];
    }>
  | Readonly<{ kind: "rejected"; code: "invalid-project-capability" | "invalid-turn-request" }>;

/**
 * The first three kinds are re-encoded from proven fields, so an extra field a generation invented
 * cannot travel further. `saved` is the only authoritative success, and exists only after the
 * thread commit returned.
 */
export type ProjectTurnFrame =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{
      kind: "tool-start";
      toolCallId: string;
      toolName: string;
      arguments: Record<string, unknown>;
    }>
  | Readonly<{
      kind: "tool-result";
      toolCallId: string;
      toolName: string;
      isError: boolean;
      content: string;
      truncated: boolean;
    }>
  | Readonly<{ kind: "diff"; content: string; truncated: boolean }>
  | Readonly<{ kind: "diff-unavailable"; detail: string }>
  | Readonly<{ kind: "saved"; revision: number; messageCount: number }>
  | Readonly<{
      kind: "turn-failed";
      code: "model-call-limit" | "model-error";
      saved: boolean;
      revision: number | undefined;
    }>
  | Readonly<{ kind: "turn-rejected"; code: "invalid-project-capability" | "invalid-turn-request" }>
  | Readonly<{ kind: "save-failed"; code: string }>
  | Readonly<{ kind: "stream-invalid"; code: TurnStreamProblem }>
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "timed-out" }>;

type ParsedFacetFrame =
  | Readonly<{ kind: "forwarded"; frame: ProjectTurnFrame }>
  | Readonly<{ kind: "unknown-kind" }>
  | Readonly<{ kind: "terminal"; frame: FacetTerminalFrame }>
  | Readonly<{ kind: "invalid"; problem: TurnStreamProblem }>;

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function toolArguments(value: unknown): Record<string, unknown> | undefined {
  return value === undefined ? {} : isRecord(value) ? value : undefined;
}

function forwarded(frame: ProjectTurnFrame): ParsedFacetFrame {
  return { kind: "forwarded", frame };
}

function terminal(frame: FacetTerminalFrame): ParsedFacetFrame {
  return { kind: "terminal", frame };
}

const malformed: ParsedFacetFrame = { kind: "invalid", problem: "malformed-frame" };

/**
 * Only the list is proven here; each message is proved by the thread's own parser when the save
 * runs.
 */
function terminalMessages(value: unknown): readonly unknown[] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const messages: unknown = value.messages;

  return Array.isArray(messages) ? messages : undefined;
}

function parseText(frame: Record<string, unknown>): ParsedFacetFrame {
  return isString(frame.text) ? forwarded({ kind: "text", text: frame.text }) : malformed;
}

function parseToolStart(frame: Record<string, unknown>): ParsedFacetFrame {
  const args = toolArguments(frame.arguments);

  if (!isString(frame.toolCallId) || !isString(frame.toolName) || args === undefined) {
    return malformed;
  }

  return forwarded({
    kind: "tool-start",
    toolCallId: frame.toolCallId,
    toolName: frame.toolName,
    arguments: args,
  });
}

function parseToolResult(frame: Record<string, unknown>): ParsedFacetFrame {
  if (
    !isString(frame.toolCallId) ||
    !isString(frame.toolName) ||
    !isString(frame.content) ||
    typeof frame.isError !== "boolean" ||
    typeof frame.truncated !== "boolean"
  ) {
    return malformed;
  }

  return forwarded({
    kind: "tool-result",
    toolCallId: frame.toolCallId,
    toolName: frame.toolName,
    isError: frame.isError,
    content: frame.content,
    truncated: frame.truncated,
  });
}

function parseDiff(frame: Record<string, unknown>): ParsedFacetFrame {
  if (!isString(frame.content) || typeof frame.truncated !== "boolean") {
    return malformed;
  }

  return forwarded({ kind: "diff", content: frame.content, truncated: frame.truncated });
}

function parseDiffUnavailable(frame: Record<string, unknown>): ParsedFacetFrame {
  return isString(frame.detail)
    ? forwarded({ kind: "diff-unavailable", detail: frame.detail })
    : malformed;
}

function parseCompleted(frame: Record<string, unknown>): ParsedFacetFrame {
  const messages = terminalMessages(frame.state);

  return messages === undefined ? malformed : terminal({ kind: "completed", messages });
}

function parseFailed(frame: Record<string, unknown>): ParsedFacetFrame {
  const messages = terminalMessages(frame.state);

  if (
    messages === undefined ||
    (frame.code !== "model-call-limit" && frame.code !== "model-error")
  ) {
    return malformed;
  }

  return terminal({ kind: "failed", code: frame.code, messages });
}

function parseRejected(frame: Record<string, unknown>): ParsedFacetFrame {
  if (frame.code !== "invalid-project-capability" && frame.code !== "invalid-turn-request") {
    return malformed;
  }

  return terminal({ kind: "rejected", code: frame.code });
}

/**
 * Every accepted frame is rebuilt from the fields its kind declares, so an added field is dropped.
 * An unknown kind is dropped rather than ending the turn; a known kind with bad fields is
 * malformed.
 */
export function parseFacetFrameLine(line: string): ParsedFacetFrame {
  let decoded: unknown;

  try {
    decoded = JSON.parse(line);
  } catch {
    return malformed;
  }

  if (!isRecord(decoded)) {
    return malformed;
  }

  switch (decoded.kind) {
    case "text":
      return parseText(decoded);
    case "tool-start":
      return parseToolStart(decoded);
    case "tool-result":
      return parseToolResult(decoded);
    case "diff":
      return parseDiff(decoded);
    case "diff-unavailable":
      return parseDiffUnavailable(decoded);
    case "completed":
      return parseCompleted(decoded);
    case "failed":
      return parseFailed(decoded);
    case "rejected":
      return parseRejected(decoded);
    default:
      return { kind: "unknown-kind" };
  }
}
