import { MANAGED_AGENT_INSTRUCTIONS_PATH } from "../../workspace-layout.js";
import type { ExecutionEnv } from "@cf-stumble/pi";

/** Read relative to the working directory, so a sibling project's file is unreachable even though clones share a workspace. */
const REPOSITORY_INSTRUCTIONS_FILE = "AGENTS.md";

/** Absent, not empty, when the file does not exist: those are different facts. */
type TurnInstructions = Readonly<{
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
 * A missing or unreadable file is absent: a turn must not fail on an unprovisioned workspace. When the
 * working directory is the workspace root both names address one file; it is reported as the managed
 * one only so the text is not sent twice.
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
