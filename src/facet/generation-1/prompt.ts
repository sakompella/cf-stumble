import type { Context } from "@earendil-works/chord";
import { defineExtension, section } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { PROJECT_RUN_DEADLINE_MS } from "../../turn-budget.js";
import { MANAGED_AGENT_INSTRUCTIONS_PATH } from "../../workspace-layout.js";

const SYSTEM_PROMPT = [
  "You are cf-stumble, a personal coding agent working in one project workspace.",
  "Use the tools to read and change files and to run the project's own commands.",
  "Prefer the edit tool over the write tool when you change part of a file.",
  "Finish by telling the user what you changed and what the commands reported.",
].join(" ");

/** Read relative to the working directory, so a sibling project's file is unreachable even though clones share a workspace. */
const REPOSITORY_INSTRUCTIONS_FILE = "AGENTS.md";

const RUN_DEADLINE_MINUTES = PROJECT_RUN_DEADLINE_MS / 60_000;

async function readOptional(
  env: ExecutionEnv,
  path: string,
  context: Context,
): Promise<string | undefined> {
  const read = await env.readTextFile(path, context);

  return read.ok && read.value.trim() !== "" ? read.value.trim() : undefined;
}

/**
 * Read at every request, so an edited `AGENTS.md` reaches a running conversation. A missing file is
 * absent: a run must not fail on an unprovisioned workspace. When the working directory is the
 * workspace root both names address one file, which is sent once.
 */
async function instructions(env: ExecutionEnv, context: Context): Promise<string | undefined> {
  const managed = await readOptional(env, MANAGED_AGENT_INSTRUCTIONS_PATH, context);
  const repositoryPath = await env.absolutePath(REPOSITORY_INSTRUCTIONS_FILE, context);

  const repository =
    repositoryPath.ok && repositoryPath.value === MANAGED_AGENT_INSTRUCTIONS_PATH
      ? undefined
      : await readOptional(env, REPOSITORY_INSTRUCTIONS_FILE, context);

  const parts = [
    managed === undefined
      ? []
      : [`## Workspace instructions (${MANAGED_AGENT_INSTRUCTIONS_PATH})`, managed],
    repository === undefined
      ? []
      : [`## Repository instructions (${REPOSITORY_INSTRUCTIONS_FILE})`, repository],
  ].flat();

  return parts.length === 0 ? undefined : parts.join("\n\n");
}

/** Generation 1's system prompt: its policy, the run's directory and budget, then the instruction files. */
export const CfStumblePrompt = defineExtension({
  name: "cf-stumble",
  sections: [
    section(
      "preamble",
      ({ agent }) =>
        [
          SYSTEM_PROMPT,
          ...(agent.cwd === undefined
            ? []
            : [
                `The selected project working directory is ${agent.cwd}.`,
                "Commands and relative paths run there.",
              ]),
          `A run has a time budget of ${RUN_DEADLINE_MINUTES} minutes. Prefer focused checks that fit within it.`,
        ].join(" "),
      { tag: false },
    ),
    section(
      "agents-md",
      ({ env }, context) => (env === undefined ? undefined : instructions(env, context)),
      { tag: false },
    ),
  ],
});
