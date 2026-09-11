import { DEFAULT_COMPACTION_SETTINGS } from "@cf-stumble/pi";
import type { CompactionPolicy } from "./compaction.js";

/**
 * The instructions Generation 0 sends with every turn. They are part of the generation, so a later
 * generation may replace them; nothing outside the facet can set them for this one. The workspace
 * and repository instructions this generation loads are appended to them by `./instructions.ts`.
 */
export const GENERATION_0_SYSTEM_PROMPT = [
  "You are cf-stumble, a personal coding agent working in one project workspace.",
  "Use the tools to read and change files and to run the project's own commands.",
  "Prefer the edit tool over the write tool when you change part of a file.",
  "This harness shows the user the repository's own diff after a turn that changed files, so do",
  "not spend a tool call on `git diff` yourself.",
  "Finish by telling the user what you changed and what the commands reported.",
].join(" ");

/**
 * How many model calls one turn may make. A turn holds a lease and a frame stream open while it
 * runs, so the bound is what keeps a tool-calling loop from holding both forever; it is a plainly
 * bounded value, not a measured one.
 */
export const MAX_MODEL_CALLS = 8;

/**
 * How much of one tool result reaches the browser in a frame, in the same two limits Pi's own
 * tools apply to their output: `createBashTool` already truncates a command's output to the last
 * 2000 lines or 50KB, and `createReadTool` truncates a file read to the first 2000 lines or 50KB.
 * Repeating those numbers here means a frame never truncates a result Pi already bounded, and it
 * bounds a result from any future tool that does not bound its own.
 *
 * The turn's own diff frame is bounded by the same two limits (goal criterion 4): a forty-line
 * diff is roughly two kilobytes, so it arrives whole, and a diff of a whole repository still
 * cannot make one frame unbounded.
 */
export const TOOL_RESULT_DISPLAY_MAX_LINES = 2_000;

export const TOOL_RESULT_DISPLAY_MAX_BYTES = 50 * 1_024;

/**
 * The command this generation runs itself at the end of a turn that could have changed a file, and
 * the seconds it may take.
 *
 * Goal criterion 4 wants a turn that shows what changed. Asking the model to run `git diff` made
 * that a hope about the model: the route is a flash model at low reasoning effort, and skipping
 * one clause of a system prompt is an ordinary event there. So the diff is a property of the turn
 * instead. The harness runs this command through the same project capability the `bash` tool uses,
 * after the model has stopped, and publishes the result as the turn's own frame.
 *
 * `HEAD` rather than the working tree alone, because a turn that staged or ran the project's own
 * check should still show its work. A file the turn created and never added to the index is not in
 * this diff; `git status` would be a second command and a second frame, which is more than
 * criterion 4 asks for.
 */
export const TURN_DIFF_COMMAND = "git --no-pager diff HEAD";

export const TURN_DIFF_TIMEOUT_SECONDS = 30;

/**
 * When this generation compacts one thread, and how much of it survives.
 *
 * `contextBudgetTokens` is this generation's own bound on a thread, not the route's context
 * window. The route does not report one: `ROUTE_MODEL` declares `contextWindow: 0` because
 * Generation 0 cannot learn the real number and must not invent it. Passing that zero to Pi's
 * `shouldCompact` would not disable compaction — the test in
 * `test/facet/generation-0/compaction.test.ts` shows `tokens > 0 - reserveTokens` is true for an
 * empty conversation — so this generation would compact every turn. A declared budget is the
 * honest alternative: like {@link MAX_MODEL_CALLS} it is a bound this harness chooses and can
 * state, not a measurement it pretends to have.
 *
 * The settings stay Pi's defaults except `keepRecentTokens`, which must be well below the
 * threshold `contextBudgetTokens - reserveTokens` or compaction would retain everything it was
 * asked to summarize.
 */
export const GENERATION_0_COMPACTION = {
  contextBudgetTokens: 64_000,
  settings: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 8_000 },
} satisfies CompactionPolicy;
