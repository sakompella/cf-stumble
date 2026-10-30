import { DEFAULT_COMPACTION_SETTINGS } from "@cf-stumble/pi";
import type { CompactionPolicy } from "./compaction.js";

export const GENERATION_0_SYSTEM_PROMPT = [
  "You are cf-stumble, a personal coding agent working in one project workspace.",
  "Use the tools to read and change files and to run the project's own commands.",
  "Prefer the edit tool over the write tool when you change part of a file.",
  "This harness shows the user the repository's own diff after a turn that changed files, so do",
  "not spend a tool call on `git diff` yourself.",
  "Finish by telling the user what you changed and what the commands reported.",
].join(" ");

/** Twenty-four calls leave room for useful turns; the 8-minute wall budget is the real bound. */
export const MAX_MODEL_CALLS = 24;

export const TURN_TOOL_TIMEOUT_RESERVE_MS = 60_000;

/**
 * The same limits as Pi's `createBashTool` and `createReadTool` (2000 lines or 50KB), so a frame never
 * truncates a result Pi already bounded. The diff frame uses them too.
 */
export const TOOL_RESULT_DISPLAY_MAX_LINES = 2_000;

export const TOOL_RESULT_DISPLAY_MAX_BYTES = 50 * 1_024;

/**
 * Run by the harness after the model stops rather than asked of the model: the route is a flash model at
 * low reasoning effort that may skip a prompt clause. `HEAD` so staged changes show; a file never added
 * to the index does not.
 */
export const TURN_DIFF_COMMAND = "git --no-pager diff HEAD";

export const TURN_DIFF_TIMEOUT_SECONDS = 90;

/**
 * `contextBudgetTokens` sits below the route's context window so a thread compacts before it fills.
 * `keepRecentTokens` must be well below `contextBudgetTokens - reserveTokens` or compaction would retain
 * everything it was asked to summarize.
 */
export const GENERATION_0_COMPACTION = {
  contextBudgetTokens: 64_000,
  settings: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 8_000 },
} satisfies CompactionPolicy;
