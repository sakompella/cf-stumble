import { truncateTail } from "@cf-stumble/pi";
import {
  TOOL_RESULT_DISPLAY_MAX_BYTES,
  TOOL_RESULT_DISPLAY_MAX_LINES,
  TURN_DIFF_COMMAND,
  TURN_DIFF_TIMEOUT_SECONDS,
} from "./turn-policy.js";
import type { ExecutionEnv } from "@cf-stumble/pi";

export type WorkspaceDiff =
  | Readonly<{ available: true; content: string; truncated: boolean }>
  | Readonly<{ available: false; detail: string }>;

/** `read` cannot change a file; `bash` can. */
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
 * Every failure resolves to an `available: false` diff carrying the command's own words. The exec path
 * silently tail-truncates output, so the bytes printed are counted to tell whether anything was dropped.
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
