import type { ProjectTurnFrame } from "../../src/supervisor/projects/turn-frames.js";
import {
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
 * The turns that differ from the recorded one by a single fact.
 *
 * Each list is the smallest change that makes one claim testable: a turn with no diff frame, a
 * stream that stops without a terminal frame, output the page must shorten, model text that looks
 * like markup, a tool that failed, and a turn whose later frames belong to a project the reader
 * has already left.
 */

/** A read-only turn: real text, a finished tool, a save, and neither kind of diff frame. */
export const NO_DIFF_FRAMES: readonly ProjectTurnFrame[] = [
  text("The README describes a self-modifying coding agent. I changed nothing."),
  ...READ_TOOL_FRAMES,
  text("Nothing needed editing, so this turn produced no diff."),
  SAVED_FRAME,
];

/** Visible text and three finished tools, then the body simply ends. */
export const NO_TERMINAL_FRAMES: readonly ProjectTurnFrame[] = [
  text(OPENING_TEXT),
  ...READ_TOOL_FRAMES,
  text(EDIT_TEXT),
  ...PATCH_TOOL_FRAMES,
  ...COMMAND_TOOL_FRAMES,
];

/** Repository content and model output that would become page markup if either were assigned. */
export const MARKUP_FRAMES: readonly ProjectTurnFrame[] = [
  text(`${MARKUP_SCRIPT_TEXT}"taken over"</script>`),
  toolStart("t1", "read_file", { path: "README.md" }),
  toolResult("t1", "read_file", `${MARKUP_IMAGE_TEXT}"alert(1)">`, false),
  SAVED_FRAME,
];

/** One successful line the server declares complete and too long for any layout. */
export const LONG_LINE_FRAMES: readonly ProjectTurnFrame[] = [
  text("The build log is one very long line."),
  toolStart("t1", "run_command", { command: "pnpm build" }),
  toolResult("t1", "run_command", longSingleLine(), false),
  SAVED_FRAME,
];

/** A tool that failed inside a turn that still saved. */
export const TOOL_FAILED_FRAMES: readonly ProjectTurnFrame[] = [
  text("Running the configured check."),
  toolStart("t1", "run_command", { command: "pnpm verify" }),
  failedToolResult("t1", "run_command", "exit 1: 2 tests failed in test/page/owner-page.test.ts"),
  SAVED_FRAME,
];

/**
 * A turn whose later frames must never reach the conversation the reader switched to. Every held
 * frame names itself, so a case can say which project's content it found.
 */
export const PROJECT_SWITCH_FRAMES: readonly ProjectTurnFrame[] = [
  text(OPENING_TEXT),
  ...READ_TOOL_FRAMES,
  text(`${EXTERNAL_LATE_MARKER} this text belongs to the project you left.`),
  toolStart("t9", "apply_patch", { path: `${EXTERNAL_LATE_MARKER}.ts` }),
  toolResult("t9", "apply_patch", `${EXTERNAL_LATE_MARKER} patched`, false),
  TURN_DIFF_FRAME,
  SAVED_FRAME,
];
