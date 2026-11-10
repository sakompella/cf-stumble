import type { GitCliResult } from "@cloudflare/computer/git";

export const OK: GitCliResult = { stdout: "", stderr: "", exitCode: 0 };

export function failure(stderr: string): GitCliResult {
  return { stdout: "", stderr, exitCode: 128 };
}

export function pathspecError(missed: readonly string[]): GitCliResult {
  return {
    stdout: "",
    stderr: missed
      .map((spec) => `error: pathspec '${spec}' did not match any file(s) known to git\n`)
      .join(""),
    exitCode: 1,
  };
}

export async function reportingFailure(run: () => Promise<GitCliResult>): Promise<GitCliResult> {
  try {
    return await run();
  } catch (cause) {
    return failure(`fatal: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  }
}
