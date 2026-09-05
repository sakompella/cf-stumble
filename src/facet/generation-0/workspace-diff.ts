import { truncateTail } from "@cf-stumble/pi";
import {
  TOOL_RESULT_DISPLAY_MAX_BYTES,
  TOOL_RESULT_DISPLAY_MAX_LINES,
  TURN_DIFF_COMMAND,
  TURN_DIFF_TIMEOUT_SECONDS,
} from "./turn-policy.js";
import type { ExecutionEnv } from "@cf-stumble/pi";

/**
 * The diff a turn produces about itself: the repository's answer to "what changed", bounded by the
 * same limits a tool result carries, or the reason the repository could not answer.
 */
export type WorkspaceDiff =
  | Readonly<{ available: true; content: string; truncated: boolean }>
  | Readonly<{ available: false; detail: string }>;

/**
 * The stock tools that can leave a file different from how the turn found it. `read` cannot, so a
 * turn that only read is a turn with nothing to show; `bash` can, because a command changes files
 * as readily as the `write` and `edit` tools do.
 */
const WORKSPACE_MUTATING_TOOLS: ReadonlySet<string> = new Set(["bash", "edit", "write"]);

export function mutatesWorkspace(toolName: string): boolean {
  return WORKSPACE_MUTATING_TOOLS.has(toolName);
}

function unavailable(detail: string): WorkspaceDiff {
  return { available: false, detail };
}

/** The first non-empty line of what the command printed, which is where git puts its complaint. */
function firstLine(text: string): string | undefined {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return undefined;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Runs {@link TURN_DIFF_COMMAND} in the turn's working directory and returns what it printed.
 *
 * This is the harness asking, not the model: it runs after the model has stopped, through the same
 * `ExecutionEnv` the turn's tools ran on, so it reaches exactly the project directory the turn
 * worked in and nothing else. Every failure the command can have — a rejected capability, a
 * timeout, a directory that is not a repository — resolves to an `available: false` diff carrying
 * the command's own words rather than throwing into the turn.
 *
 * The exec path already bounds a command's buffered output to the tail of the same two limits, and
 * it does so silently, so re-truncating here cannot tell a reader whether anything was dropped.
 * Counting the bytes the command printed can: a diff longer than what survived is a diff the frame
 * carries the end of, and it says so.
 */
export async function readWorkspaceDiff(
  env: ExecutionEnv,
  signal: AbortSignal,
): Promise<WorkspaceDiff> {
  let printedBytes = 0;
  const result = await env.exec(TURN_DIFF_COMMAND, {
    abortSignal: signal,
    timeout: TURN_DIFF_TIMEOUT_SECONDS,
    onStdout: (chunk) => {
      printedBytes += utf8Length(chunk);
    },
  });
  if (!result.ok) return unavailable(result.error.message);

  const { stdout, stderr, exitCode } = result.value;
  if (exitCode !== 0) {
    return unavailable(firstLine(stderr) ?? `${TURN_DIFF_COMMAND} exited ${exitCode}`);
  }

  const truncation = truncateTail(stdout, {
    maxLines: TOOL_RESULT_DISPLAY_MAX_LINES,
    maxBytes: TOOL_RESULT_DISPLAY_MAX_BYTES,
  });
  const truncated = truncation.truncated || printedBytes > utf8Length(truncation.content);
  return { available: true, content: truncation.content, truncated };
}
