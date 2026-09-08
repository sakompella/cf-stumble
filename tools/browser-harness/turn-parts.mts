import type { ProjectTurnFrame } from "../../src/supervisor/projects/turn-frames.js";

/**
 * The pieces every recorded turn is built from.
 *
 * They live apart from the scripts that use them because the scripts differ from each other in one
 * respect at a time — no diff frame, no terminal frame, a failed tool, output too long to lay out
 * — and a case can only name which difference it is looking at if everything else is identical.
 */

export const TOOL_PATCH_DIFF = [
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
 * The turn's own diff, produced by the harness rather than by the model (ADR-0040). Its file, its
 * line counts, and its hunk header all differ from the `apply_patch` tool result, so a case can
 * name which of the two it is looking at.
 */
export const WORKSPACE_DIFF = [
  "diff --git a/src/routes/turns.ts b/src/routes/turns.ts",
  "index 91c4d0a..c7e2f11 100644",
  "--- a/src/routes/turns.ts",
  "+++ b/src/routes/turns.ts",
  "@@ -22,8 +22,9 @@ the turn route",
  "   const body = await request.json();",
  "-  const projectId = body.projectId;",
  "-  return supervisor.runTurn(projectId);",
  "+  const project = parseProjectId(body.projectId);",
  "+  const prompt = parsePrompt(body.prompt);",
  "+  return supervisor.runTurn(project, prompt);",
  " }",
].join("\n");

export const EXTERNAL_LATE_MARKER = "EXTERNAL-LATE";
export const LONG_LINE_START_MARKER = "LONG-START";
export const LONG_LINE_END_MARKER = "LONG-END";
export const LONG_LINE_CHARACTERS = 200_000;
export const MARKUP_IMAGE_TEXT = "<img src=x onerror=";
export const MARKUP_SCRIPT_TEXT = "<script>document.title=";
export const RETAINED_EDIT_MARKER = "EARLIER-EDIT-KEPT";

export function text(value: string): ProjectTurnFrame {
  return { kind: "text", text: value };
}

export function toolStart(
  toolCallId: string,
  toolName: string,
  args: Record<string, string>,
): ProjectTurnFrame {
  return { kind: "tool-start", toolCallId, toolName, arguments: args };
}

export function toolResult(
  toolCallId: string,
  toolName: string,
  content: string,
  truncated: boolean,
): ProjectTurnFrame {
  return { kind: "tool-result", toolCallId, toolName, isError: false, content, truncated };
}

export function failedToolResult(
  toolCallId: string,
  toolName: string,
  content: string,
): ProjectTurnFrame {
  return { kind: "tool-result", toolCallId, toolName, isError: true, content, truncated: false };
}

export const SAVED_FRAME: ProjectTurnFrame = { kind: "saved", revision: 4, messageCount: 6 };

export const TURN_DIFF_FRAME: ProjectTurnFrame = {
  kind: "diff",
  content: WORKSPACE_DIFF,
  truncated: false,
};

/**
 * A tool result at the size a real `pnpm install` or test run produces. The Supervisor bounds a
 * forwarded frame at 256 KiB (`PROJECT_TURN_FRAME_MAX_BYTES`), so this stays under that: the point
 * is a result the page must survive, not a protocol violation.
 */
export function largeToolOutput(): string {
  return "warn: this line stands in for one line of a very long build log\n".repeat(2900);
}

/** One line the page must bound on its own: the server declares it complete. */
export function longSingleLine(): string {
  const filler = "x".repeat(
    LONG_LINE_CHARACTERS - LONG_LINE_START_MARKER.length - LONG_LINE_END_MARKER.length,
  );
  return `${LONG_LINE_START_MARKER}${filler}${LONG_LINE_END_MARKER}`;
}

export const READ_TOOL_FRAMES: readonly ProjectTurnFrame[] = [
  toolStart("t1", "read_file", { path: "README.md" }),
  toolResult(
    "t1",
    "read_file",
    "# cf-stumble\n\nA self-modifying coding agent that runs on Cloudflare Workers.\n",
    false,
  ),
];

export const PATCH_TOOL_FRAMES: readonly ProjectTurnFrame[] = [
  toolStart("t2", "apply_patch", { path: "src/page/markup.ts" }),
  toolResult("t2", "apply_patch", TOOL_PATCH_DIFF, false),
];

export const COMMAND_TOOL_FRAMES: readonly ProjectTurnFrame[] = [
  toolStart("t3", "run_command", { command: "pnpm verify" }),
  toolResult("t3", "run_command", largeToolOutput(), true),
];

export const OPENING_TEXT = "Reading the repository before I change anything.";
export const EDIT_TEXT = "The owner page needs a sidebar, so here is the edit.";
export const CLOSING_TEXT = `Verification passed, and ${RETAINED_EDIT_MARKER} is still in the workspace.`;
