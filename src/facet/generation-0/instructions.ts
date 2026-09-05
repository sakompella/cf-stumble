import { MANAGED_AGENT_INSTRUCTIONS_PATH } from "../../workspace-layout.js";
import type { ExecutionEnv } from "@cf-stumble/pi";

/**
 * The instruction file a repository keeps for a coding agent, read relative to the turn's working
 * directory. That directory is the selected project's clone, so this is the selected project's own
 * file: a sibling project's instructions live under a different working directory and cannot be
 * reached by this name, even though both clones share one workspace (ADR-0038).
 */
export const REPOSITORY_INSTRUCTIONS_FILE = "AGENTS.md";

/**
 * What one turn found. Each part is absent rather than empty when the file does not exist, because
 * "no repository instructions" and "an empty AGENTS.md" are different facts and only the first is
 * the ordinary case.
 */
export type TurnInstructions = Readonly<{
  managed: string | undefined;
  repository: string | undefined;
}>;

async function readOptional(
  env: ExecutionEnv,
  path: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const read = await env.readTextFile(path, signal);
  return read.ok ? read.value : undefined;
}

async function absoluteOrPath(
  env: ExecutionEnv,
  path: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const resolved = await env.absolutePath(path, signal);
  return resolved.ok ? resolved.value : path;
}

/**
 * Load the instructions this turn runs under, through the same execution adapter its tools use.
 *
 * The managed file is the one cf-stumble provisions for the whole workspace (T3a owns its path);
 * the repository file is whatever the selected project keeps. A missing or unreadable file is
 * simply absent: a project without an `AGENTS.md` is normal, and a turn must not fail because the
 * workspace has not been provisioned yet.
 *
 * When the working directory is the workspace root the two names address one file. It is reported
 * as the managed one only, so a turn started there does not receive the same text twice.
 */
export async function loadTurnInstructions(
  env: ExecutionEnv,
  signal?: AbortSignal,
): Promise<TurnInstructions> {
  const managed = await readOptional(env, MANAGED_AGENT_INSTRUCTIONS_PATH, signal);
  const repositoryPath = await absoluteOrPath(env, REPOSITORY_INSTRUCTIONS_FILE, signal);
  if (repositoryPath === MANAGED_AGENT_INSTRUCTIONS_PATH) return { managed, repository: undefined };
  return { managed, repository: await readOptional(env, REPOSITORY_INSTRUCTIONS_FILE, signal) };
}

function section(heading: string, body: string | undefined): readonly string[] {
  return body === undefined || body.trim() === "" ? [] : [`## ${heading}`, body.trim()];
}

/**
 * Build the system prompt one turn sends: this generation's own instructions, then the workspace's,
 * then the selected repository's. Later sections are more specific, which is the order a reader of
 * the prompt would expect, and each is labelled with the file it came from so the model can tell
 * the workspace's standing rules from the project's.
 */
export function composeSystemPrompt(base: string, instructions: TurnInstructions): string {
  return [
    base,
    ...section(`Workspace instructions (${MANAGED_AGENT_INSTRUCTIONS_PATH})`, instructions.managed),
    ...section(
      `Repository instructions (${REPOSITORY_INSTRUCTIONS_FILE})`,
      instructions.repository,
    ),
  ].join("\n\n");
}
