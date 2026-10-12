import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import type { ProjectTurnFrame } from "../../supervisor/projects/turn-frames.js";

/**
 * The browser's half of the turn stream: the frames `routes/turns.ts` writes, one JSON object per
 * line (`supervisor/projects/turn-frames.ts`). Exactly one terminal frame ends a stream, and it is
 * the Supervisor's own statement about what was durably saved, so this page never reports success
 * from an HTTP status: `saved` is the only success wording.
 *
 * The Schema is checked against the Supervisor's own type below, so a frame kind added on the
 * server without a reader here fails to compile.
 */
export const TurnFrame = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("tool-start"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    arguments: Schema.Record(Schema.String, Schema.Unknown),
  }),
  Schema.Struct({
    kind: Schema.Literal("tool-result"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    isError: Schema.Boolean,
    content: Schema.String,
    truncated: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("diff"),
    content: Schema.String,
    truncated: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal("diff-unavailable"), detail: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("saved"),
    revision: Schema.Number,
    messageCount: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal("turn-failed"),
    code: Schema.Literals(["model-call-limit", "model-error"]),
    saved: Schema.Boolean,
    revision: Schema.optionalKey(Schema.Number),
  }),
  Schema.Struct({
    kind: Schema.Literal("turn-rejected"),
    code: Schema.Literals(["invalid-project-capability", "invalid-turn-request"]),
  }),
  Schema.Struct({ kind: Schema.Literal("save-failed"), code: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("stream-invalid"),
    code: Schema.Literals(["malformed-frame", "oversized-frame", "missing-terminal-frame"]),
  }),
  Schema.Struct({ kind: Schema.Literal("cancelled") }),
  Schema.Struct({ kind: Schema.Literal("timed-out") }),
]);

export type TurnFrame = typeof TurnFrame.Type;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type FrameKinds = Same<TurnFrame["kind"], ProjectTurnFrame["kind"]>;

export const FRAME_KINDS_MATCH_THE_SUPERVISOR: FrameKinds = true;

const PROGRESS_KINDS = ["text", "tool-start", "tool-result", "diff", "diff-unavailable"] as const;

/** A frame that adds to the transcript while the turn runs. */
export type ProgressFrame = Extract<TurnFrame, Readonly<{ kind: (typeof PROGRESS_KINDS)[number] }>>;

/** The Supervisor's one statement about how the turn ended. */
export type TerminalFrame = Exclude<TurnFrame, ProgressFrame>;

export function isTerminalFrame(frame: TurnFrame): frame is TerminalFrame {
  return !PROGRESS_KINDS.some((kind) => kind === frame.kind);
}

function text(value: string | number | undefined): string {
  return value === undefined ? "" : String(value);
}

export const terminalText: (frame: TerminalFrame) => string = Match.type<TerminalFrame>().pipe(
  Match.discriminatorsExhaustive("kind")({
    saved: (frame) => `saved · revision ${frame.revision} · ${frame.messageCount} messages`,
    "turn-failed": (frame) =>
      `failed: ${frame.code}${frame.saved ? ` · saved at revision ${text(frame.revision)}` : " · not saved"}`,
    "turn-rejected": (frame) => `rejected: ${frame.code}`,
    "save-failed": (frame) => `not saved: ${frame.code}`,
    "stream-invalid": (frame) => `unreadable turn stream: ${frame.code}`,
    cancelled: () => "cancelled",
    "timed-out": () => "timed out",
  }),
);
