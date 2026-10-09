import type { ProjectTurnFrame } from "../../src/supervisor/projects/turn-frames.js";
import type { HarnessScenario } from "./fixtures.mjs";
import {
  CLOSING_TEXT,
  COMMAND_TOOL_FRAMES,
  EDIT_TEXT,
  EXTERNAL_LATE_MARKER,
  MARKUP_IMAGE_TEXT,
  MARKUP_SCRIPT_TEXT,
  OPENING_TEXT,
  PATCH_TOOL_FRAMES,
  READ_TOOL_FRAMES,
  SAVED_FRAME,
  TURN_DIFF_FRAME,
  failedToolResult,
  longSingleLine,
  text,
  toolResult,
  toolStart,
} from "./turn-parts.mjs";

/**
 * One turn, as the Supervisor would stream it, and where the server stops to let a case look.
 *
 * The order is the point. A tool call starts and returns before any terminal frame, one tool
 * result is a real unified diff, and one is large enough that a page which formats results eagerly
 * will stall on it. A case that only asserted on the final state would pass a page that renders
 * nothing until the stream ends, so the frames arrive separately and mean different things.
 *
 * `hold` is how a case observes a turn that is still running. The server writes that many frames,
 * reports the barrier, and waits: whatever the page shows at that moment it showed before the
 * response body ended, which is the only proof of streaming that a page cannot fake by buffering.
 */

export type TurnScript = Readonly<{
  frames: readonly ProjectTurnFrame[];
  /** Frames to write before waiting for a release. Zero streams the whole turn. */
  hold: number;
}>;

/** The barrier both pauseable turns use: the first text, and one completed tool. */
const FIRST_TEXT_AND_TOOL = 3;

function readyFrames(terminal: ProjectTurnFrame): readonly ProjectTurnFrame[] {
  return [
    text(OPENING_TEXT),
    ...READ_TOOL_FRAMES,
    text(EDIT_TEXT),
    ...PATCH_TOOL_FRAMES,
    ...COMMAND_TOOL_FRAMES,
    text(CLOSING_TEXT),
    TURN_DIFF_FRAME,
    terminal,
  ];
}

const DIFF_UNAVAILABLE_FRAME: ProjectTurnFrame = {
  kind: "diff-unavailable",
  detail: "the workspace held no git repository, so this turn produced no diff",
};

/**
 * What ends each recorded turn. `saved` is the only success the page may report (ADR-0037). A frame
 * that says the thread was saved is restated by the stub with the revision and message count it
 * actually stored (`server-turn.mts`), so the numbers here are only a first turn's.
 */
const SAVED: ProjectTurnFrame = { kind: "saved", revision: 4, messageCount: 10 };

const ENDINGS = new Map<HarnessScenario, ProjectTurnFrame>([
  ["turn-failed", { kind: "turn-failed", code: "model-error", saved: true, revision: 4 }],
  ["save-failed", { kind: "save-failed", code: "stale-revision" }],
  ["stream-invalid", { kind: "stream-invalid", code: "malformed-frame" }],
  ["cancelled", { kind: "cancelled" }],
  ["timed-out", { kind: "timed-out" }],
  ["turn-conflict", { kind: "cancelled" }],
  ["no-active-generation", { kind: "cancelled" }],
]);

/*
 * The turns that differ from the recorded one by a single fact.
 *
 * Each list is the smallest change that makes one claim testable: a turn with no diff frame, a
 * stream that stops without a terminal frame, output the page must shorten, model text that looks
 * like markup, a tool that failed, and a turn whose later frames belong to a project the reader
 * has already left.
 */

/** A read-only turn: real text, a finished tool, a save, and neither kind of diff frame. */
const NO_DIFF_FRAMES: readonly ProjectTurnFrame[] = [
  text("The README describes a self-modifying coding agent. I changed nothing."),
  ...READ_TOOL_FRAMES,
  text("Nothing needed editing, so this turn produced no diff."),
  SAVED_FRAME,
];

/** Visible text and three finished tools, then the body simply ends. */
const NO_TERMINAL_FRAMES: readonly ProjectTurnFrame[] = [
  text(OPENING_TEXT),
  ...READ_TOOL_FRAMES,
  text(EDIT_TEXT),
  ...PATCH_TOOL_FRAMES,
  ...COMMAND_TOOL_FRAMES,
];

/** Repository content and model output that would become page markup if either were assigned. */
const MARKUP_FRAMES: readonly ProjectTurnFrame[] = [
  text(`${MARKUP_SCRIPT_TEXT}"taken over"</script>`),
  toolStart("t1", "read_file", { path: "README.md" }),
  toolResult("t1", "read_file", `${MARKUP_IMAGE_TEXT}"alert(1)">`, false),
  SAVED_FRAME,
];

/** One successful line the server declares complete and too long for any layout. */
const LONG_LINE_FRAMES: readonly ProjectTurnFrame[] = [
  text("The build log is one very long line."),
  toolStart("t1", "run_command", { command: "pnpm build" }),
  toolResult("t1", "run_command", longSingleLine(), false),
  SAVED_FRAME,
];

/** A tool that failed inside a turn that still saved. */
const TOOL_FAILED_FRAMES: readonly ProjectTurnFrame[] = [
  text("Running the configured check."),
  toolStart("t1", "run_command", { command: "pnpm verify" }),
  failedToolResult("t1", "run_command", "exit 1: 2 tests failed in test/page/owner-page.test.ts"),
  SAVED_FRAME,
];

/**
 * A turn whose later frames must never reach the conversation the reader switched to. Every held
 * frame names itself, so a case can say which project's content it found.
 */
const PROJECT_SWITCH_FRAMES: readonly ProjectTurnFrame[] = [
  text(OPENING_TEXT),
  ...READ_TOOL_FRAMES,
  text(`${EXTERNAL_LATE_MARKER} this text belongs to the project you left.`),
  toolStart("t9", "apply_patch", { path: `${EXTERNAL_LATE_MARKER}.ts` }),
  toolResult("t9", "apply_patch", `${EXTERNAL_LATE_MARKER} patched`, false),
  TURN_DIFF_FRAME,
  SAVED_FRAME,
];

const VARIANTS = new Map<HarnessScenario, TurnScript>([
  ["ready-paused", { frames: readyFrames(SAVED), hold: FIRST_TEXT_AND_TOOL }],
  ["no-terminal-frame", { frames: NO_TERMINAL_FRAMES, hold: 0 }],
  ["no-diff", { frames: NO_DIFF_FRAMES, hold: 0 }],
  ["markup-output", { frames: MARKUP_FRAMES, hold: 0 }],
  ["long-line", { frames: LONG_LINE_FRAMES, hold: 0 }],
  ["tool-failed", { frames: TOOL_FAILED_FRAMES, hold: 0 }],
  ["project-switch", { frames: PROJECT_SWITCH_FRAMES, hold: FIRST_TEXT_AND_TOOL }],
]);

export function turnScript(scenario: HarnessScenario): TurnScript {
  const variant = VARIANTS.get(scenario);

  if (variant !== undefined) {
    return variant;
  }

  const terminal = ENDINGS.get(scenario) ?? SAVED;

  const frames =
    scenario === "diff-unavailable"
      ? [...readyFrames(terminal).slice(0, -2), DIFF_UNAVAILABLE_FRAME, terminal]
      : readyFrames(terminal);

  return { frames, hold: 0 };
}
