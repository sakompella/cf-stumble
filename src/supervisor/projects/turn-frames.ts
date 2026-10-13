// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- This module is the parse boundary for a generation's turn stream. A generation is mutable harness code, so nothing it writes into a frame has a proven shape until these functions prove it.
import { isRecord } from "../../untrusted.js";

/**
 * The turn stream, in both of its forms.
 *
 * A generation writes newline-delimited {@link FacetTurnFrame}s (`facet/generation-0/turn-frames.ts`).
 * The Supervisor reads them, proves each one, and writes {@link ProjectTurnFrame}s to the browser.
 * The two vocabularies differ where it matters: a generation's `completed` frame is provisional
 * evidence that carries Pi state, while the browser's terminal frame is the Supervisor's own
 * statement about what was durably saved (ADR-0037). Nothing a generation emits reaches a browser
 * unparsed, and the Pi state never does at all.
 */

/**
 * The most one line of a generation's stream may occupy, in UTF-8 bytes. A generation that writes a
 * longer line has broken the protocol, so the turn ends as an invalid stream rather than growing a
 * buffer until the isolate dies.
 *
 * A progress frame carries at most one tool result or diff, which Generation 0 bounds to 50 KiB
 * (`facet/generation-0/turn-policy.ts`); the progress bound leaves room for JSON escaping on top.
 *
 * A terminal frame carries the whole conversation, so it has its own, larger bound. The model route
 * refuses a request over 1 MiB (`model-route.ts`), so the conversation a turn's last model call
 * sent is at most that. After it the turn adds one reply of at most 4096 output tokens and the
 * results of that reply's tool calls, each again at most 50 KiB.
 *
 * The Supervisor stores that conversation as one SQLite value, and Cloudflare caps a Durable Object
 * string, BLOB, or row at 2 MB. The terminal bound stays below that with margin, so a conversation
 * the store could not hold ends the turn as `oversized-frame` instead of failing the save. It
 * still leaves room for about fifteen full tool results after the last 1 MiB request.
 */
export const TURN_PROGRESS_FRAME_MAX_BYTES = 262_144;

export const TURN_TERMINAL_FRAME_MAX_BYTES = 1_835_008;

/** Why a turn stream could not be read as frames. Each one ends the turn without a save. */
export type TurnStreamProblem = "malformed-frame" | "oversized-frame" | "missing-terminal-frame";

/** A generation's terminal frame: the three endings a turn can reach inside the facet. */
export type FacetTerminalFrame =
  | Readonly<{ kind: "completed"; messages: readonly unknown[] }>
  | Readonly<{
      kind: "failed";
      code: "model-call-limit" | "model-error";
      messages: readonly unknown[];
    }>
  | Readonly<{ kind: "rejected"; code: "invalid-project-capability" | "invalid-turn-request" }>;

/**
 * What the browser receives. The first three kinds are a generation's own frames, re-encoded from
 * proven fields so an extra field a generation invented cannot travel further; the rest are the
 * Supervisor's, and exactly one of them ends every stream.
 *
 * The `diff` pair is the generation's own answer to what the turn changed, produced by the harness
 * rather than by the model (`facet/generation-0/workspace-diff.ts`), and forwarded here on the
 * same terms as a tool result: proven fields only, and bounded by the frame limit above.
 *
 * `saved` is the only authoritative success, and it exists only after the thread commit returned.
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

/** One proven frame of a generation's stream: something to forward, or the turn's ending. */
type ParsedFacetFrame =
  | Readonly<{ kind: "forwarded"; frame: ProjectTurnFrame }>
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
 * The conversation a terminal frame carries. Only the list is proven here: each message is proved
 * by the thread's own parser when the save runs (`threads/messages.ts`), so this module does not
 * fork that schema into a second opinion about what a Pi message is.
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
 * Prove one line of a generation's turn stream.
 *
 * Every accepted frame is rebuilt from the fields its kind declares, so a field a generation added
 * is dropped here rather than forwarded to a browser, and an unknown kind is a malformed stream
 * rather than something to pass through.
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
      return malformed;
  }
}
