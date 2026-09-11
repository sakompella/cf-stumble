import type { ProjectTurnFrame } from "../../src/supervisor/projects/turn-frames.js";
import type { HarnessScenario } from "./fixtures.mjs";
import {
  LONG_LINE_FRAMES,
  MARKUP_FRAMES,
  NO_DIFF_FRAMES,
  NO_TERMINAL_FRAMES,
  PROJECT_SWITCH_FRAMES,
  TOOL_FAILED_FRAMES,
} from "./turn-fixture-variants.mjs";
import {
  CLOSING_TEXT,
  COMMAND_TOOL_FRAMES,
  EDIT_TEXT,
  OPENING_TEXT,
  PATCH_TOOL_FRAMES,
  READ_TOOL_FRAMES,
  TURN_DIFF_FRAME,
  text,
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

/** What ends each recorded turn. `saved` is the only success the page may report (ADR-0037). */
const SAVED: ProjectTurnFrame = { kind: "saved", revision: 4, messageCount: 6 };

const ENDINGS = new Map<HarnessScenario, ProjectTurnFrame>([
  ["turn-failed", { kind: "turn-failed", code: "model-error", saved: true, revision: 4 }],
  ["save-failed", { kind: "save-failed", code: "stale-revision" }],
  ["stream-invalid", { kind: "stream-invalid", code: "malformed-frame" }],
  ["cancelled", { kind: "cancelled" }],
  ["timed-out", { kind: "timed-out" }],
  ["turn-conflict", { kind: "cancelled" }],
  ["no-active-generation", { kind: "cancelled" }],
]);

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
