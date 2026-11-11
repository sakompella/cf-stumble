import type { Context } from "@earendil-works/chord";
import { defineExtension, section } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { PROJECT_RUN_DEADLINE_MS } from "../../turn-budget.js";
import { HARNESS_DIRECTORY, MANAGED_AGENT_INSTRUCTIONS_PATH } from "../../workspace-layout.js";
import systemText from "./SYSTEM.md";

const SYSTEM = systemText.replaceAll("{{HARNESS_DIRECTORY}}", HARNESS_DIRECTORY).trim();

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

export const CfStumblePrompt = defineExtension({
  name: "cf-stumble",
  sections: [
    section("system", () => SYSTEM, { tag: false }),
    section(
      "project",
      ({ agent }) =>
        [
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
