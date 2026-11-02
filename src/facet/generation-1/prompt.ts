import type { Context } from "@earendil-works/chord";
import { defineExtension, section } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { PROJECT_RUN_DEADLINE_MS } from "../../turn-budget.js";
import { HARNESS_DIRECTORY, MANAGED_AGENT_INSTRUCTIONS_PATH } from "../../workspace-layout.js";

const SYSTEM_PROMPT = [
  "You are cf-stumble, a personal coding agent working in one project workspace.",
  "Use the tools to read and change files and to run the project's own commands.",
  "Prefer the edit tool over the write tool when you change part of a file.",
  "Finish by telling the user what you changed and what the commands reported.",
].join(" ");

const SELF_MODIFICATION = [
  `Your own source is the git checkout at ${HARNESS_DIRECTORY}.`,
  "To change yourself, commit the change there, then push that exact commit with",
  "`git push origin <sha>:refs/heads/self-modify/<change>`; if the push fails, stop and report the failure.",
  "Run `stumble gen prepare <sha>`. Activate only when it reports the generation ready,",
  "with the `stumble gen activate <label> --epoch <n>` command it prints.",
  "Activation replaces the running agent, so that command may come back interrupted:",
  "then run `stumble gen status`, and when your generation is active, tell the user it is already active.",
  "`stumble` with no arguments lists its commands; it runs on its own, not in pipelines or with shell syntax.",
].join(" ");

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
    section("self-modification", () => SELF_MODIFICATION, { tag: false }),
    section(
      "agents-md",
      ({ env }, context) => (env === undefined ? undefined : instructions(env, context)),
      { tag: false },
    ),
  ],
});
