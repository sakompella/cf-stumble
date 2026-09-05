import type { ProjectTurnFrame } from "../../src/supervisor/projects/turn-frames.js";
import type { HarnessScenario } from "./fixtures.mjs";

/**
 * One turn, as the Supervisor would stream it.
 *
 * The order is the point. A tool call starts and returns before any terminal frame, one tool
 * result is a real unified diff, and one is large enough that a page which formats results
 * eagerly will stall on it. A check that only asserted on the final state would pass a page that
 * renders nothing until the stream ends, so the harness needs frames that arrive separately and
 * mean different things.
 */

const DIFF = [
  "diff --git a/src/page/markup.ts b/src/page/markup.ts",
  "index 3f1a9c2..8b40e17 100644",
  "--- a/src/page/markup.ts",
  "+++ b/src/page/markup.ts",
  "@@ -14,7 +14,10 @@ the owner page body",
  '   <main class="owner">',
  '-    <div class="projects"></div>',
  '+    <nav class="projects" aria-label="Projects">',
  '+      <ul class="project-list"></ul>',
  "+    </nav>",
  "   </main>",
].join("\n");

/**
 * A tool result at the size a real `pnpm install` or test run produces. The Supervisor bounds a
 * forwarded frame at 256 KiB (`PROJECT_TURN_FRAME_MAX_BYTES`), so this stays under that: the point
 * is a result the page must survive, not a protocol violation.
 */
function largeToolOutput(): string {
  return "warn: this line stands in for one line of a very long build log\n".repeat(2900);
}

const TERMINAL = {
  ready: { kind: "saved", revision: 4, messageCount: 6, credited: true },
  "github-disconnected": { kind: "saved", revision: 4, messageCount: 6, credited: true },
  "github-awaiting-authorization": {
    kind: "saved",
    revision: 4,
    messageCount: 6,
    credited: true,
  },
  "turn-failed": { kind: "turn-failed", code: "model-error", saved: true, revision: 4 },
  "save-failed": { kind: "save-failed", code: "stale-revision" },
  "stream-invalid": { kind: "stream-invalid", code: "malformed-frame" },
  cancelled: { kind: "cancelled" },
  "timed-out": { kind: "timed-out" },
  "turn-conflict": { kind: "cancelled" },
  "no-active-generation": { kind: "cancelled" },
} satisfies Readonly<Record<HarnessScenario, ProjectTurnFrame>>;

export function turnFrames(scenario: HarnessScenario): readonly ProjectTurnFrame[] {
  return [
    { kind: "text", text: "Reading the repository before I change anything." },
    {
      kind: "tool-start",
      toolCallId: "t1",
      toolName: "read_file",
      arguments: { path: "README.md" },
    },
    {
      kind: "tool-result",
      toolCallId: "t1",
      toolName: "read_file",
      isError: false,
      content: "# cf-stumble\n\nA self-modifying coding agent that runs on Cloudflare Workers.\n",
      truncated: false,
    },
    { kind: "text", text: "The owner page needs a sidebar, so here is the edit." },
    {
      kind: "tool-start",
      toolCallId: "t2",
      toolName: "apply_patch",
      arguments: { path: "src/page/markup.ts" },
    },
    {
      kind: "tool-result",
      toolCallId: "t2",
      toolName: "apply_patch",
      isError: false,
      content: DIFF,
      truncated: false,
    },
    {
      kind: "tool-start",
      toolCallId: "t3",
      toolName: "run_command",
      arguments: { command: "pnpm verify" },
    },
    {
      kind: "tool-result",
      toolCallId: "t3",
      toolName: "run_command",
      isError: false,
      content: largeToolOutput(),
      truncated: true,
    },
    { kind: "text", text: "Verification passed, so the change is ready to review." },
    TERMINAL[scenario],
  ];
}
