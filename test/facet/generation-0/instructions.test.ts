import { expect, test } from "vitest";
import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import { createFacetExecutionEnv } from "../../../src/facet/generation-0/execution-env.js";
import {
  createPiAgentTurnState,
  loadTurnInstructions,
  runPiAgentTurn,
} from "../../../src/facet/generation-0/index.js";
import { parseProjectId } from "../../../src/project-catalog.js";
import {
  MANAGED_AGENT_INSTRUCTIONS_PATH,
  projectDirectory,
} from "../../../src/workspace-layout.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
} from "../../workspace/project/fakes.js";
import { assistant, scriptedModel as model, scriptedStream } from "./scripted-model.js";
import type { ExecutionEnv } from "@cf-stumble/pi";

/** The clone directory of one catalog project, named the way `workspace-layout.ts` names it. */
function projectCwd(id: string): string {
  const projectId = parseProjectId(id);
  if (projectId === undefined) throw new Error(`${id} is not a project id`);
  return projectDirectory(projectId);
}

const MANAGED = "Never print or commit authentication tokens.";
const PROJECT_ONE = "Run ./one-check before you finish.";
const PROJECT_TWO = "Never mention the second project's secret plan.";

/**
 * One shared workspace holding two project clones and the managed instruction file above them,
 * which is the layout `workspace-layout.ts` describes (ADR-0038). Both environments read through
 * the same real `ProjectRpcTarget`, so "the other project's file is not reached" is a fact about
 * the working directory rather than about two separate fakes.
 */
async function sharedWorkspace(): Promise<Readonly<Record<"one" | "two", ExecutionEnv>>> {
  const provider = new FakeProjectFilesystemProvider();
  const projectTarget = new ProjectRpcTarget(
    provider,
    new FakeProjectTransactions(),
    new FakeExecBackend(),
  );
  const environments = {
    one: createFacetExecutionEnv({ cwd: projectCwd("project-one"), projectTarget }),
    two: createFacetExecutionEnv({ cwd: projectCwd("project-two"), projectTarget }),
  } as const;

  await environments.one.writeFile(MANAGED_AGENT_INSTRUCTIONS_PATH, MANAGED);
  await environments.one.writeFile("AGENTS.md", PROJECT_ONE);
  await environments.two.writeFile("AGENTS.md", PROJECT_TWO);
  return environments;
}

test("loads the managed file and only the selected project's own instructions", async () => {
  const environments = await sharedWorkspace();

  const one = await loadTurnInstructions(environments.one);
  const two = await loadTurnInstructions(environments.two);

  expect(one).toEqual({ managed: MANAGED, repository: PROJECT_ONE });
  expect(two).toEqual({ managed: MANAGED, repository: PROJECT_TWO });
});

test("both instruction files reach the prompt of the turn that runs in that project", async () => {
  const environments = await sharedWorkspace();
  const script = scriptedStream([assistant([{ type: "text", text: "Understood." }], "stop")]);

  await runPiAgentTurn({
    prompt: "What are the rules here?",
    state: createPiAgentTurnState(model),
    env: environments.one,
    streamFn: script.streamFn,
  });

  const systemPrompt = script.contexts[0]?.systemPrompt ?? "";
  expect(systemPrompt).toContain(MANAGED);
  expect(systemPrompt).toContain(PROJECT_ONE);
  expect(systemPrompt).toContain(MANAGED_AGENT_INSTRUCTIONS_PATH);
  expect(
    systemPrompt,
    "the sibling project's instructions share a workspace, not a prompt",
  ).not.toContain(PROJECT_TWO);
});

/**
 * The saved conversation is an argument of the turn, and the workspace is the only thing the two
 * projects share. A turn started for the second project therefore carries the second project's
 * messages and the second project's instructions, even though the first project's turn wrote its
 * conversation while running against the same files a moment earlier.
 */
test("a project's own conversation is the only one its turn sends", async () => {
  const environments = await sharedWorkspace();
  const first = scriptedStream([assistant([{ type: "text", text: "Noted for one." }], "stop")]);
  const opening = await runPiAgentTurn({
    prompt: "Remember the first project's login bug.",
    state: createPiAgentTurnState(model),
    env: environments.one,
    streamFn: first.streamFn,
  });
  expect(opening.ok).toBe(true);

  const second = scriptedStream([assistant([{ type: "text", text: "Noted for two." }], "stop")]);
  await runPiAgentTurn({
    prompt: "What should I do here?",
    state: createPiAgentTurnState(model),
    env: environments.two,
    streamFn: second.streamFn,
  });

  const context = second.contexts[0];
  expect(context?.messages.map((message) => message.role)).toEqual(["user"]);
  expect(JSON.stringify(context?.messages)).not.toContain("login bug");
  expect(context?.systemPrompt ?? "").toContain(PROJECT_TWO);
});

test("a project without its own instruction file still runs, with the managed file alone", async () => {
  const provider = new FakeProjectFilesystemProvider();
  const projectTarget = new ProjectRpcTarget(
    provider,
    new FakeProjectTransactions(),
    new FakeExecBackend(),
  );
  const env = createFacetExecutionEnv({ cwd: projectCwd("project-one"), projectTarget });
  await env.writeFile(MANAGED_AGENT_INSTRUCTIONS_PATH, MANAGED);

  expect(await loadTurnInstructions(env)).toEqual({ managed: MANAGED, repository: undefined });
});

test("an unprovisioned workspace loads no instructions rather than failing the turn", async () => {
  const projectTarget = new ProjectRpcTarget(
    new FakeProjectFilesystemProvider(),
    new FakeProjectTransactions(),
    new FakeExecBackend(),
  );
  const env = createFacetExecutionEnv({ cwd: projectCwd("project-one"), projectTarget });

  expect(await loadTurnInstructions(env)).toEqual({ managed: undefined, repository: undefined });
});
