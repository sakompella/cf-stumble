import {
  Agent,
  convertToLlm,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@cf-stumble/pi";
import type {
  AgentEvent,
  AgentHarnessTool,
  AgentMessage,
  AgentState,
  AgentTool,
  ExecutionEnv,
  ExecutionToolContext,
  StreamFn,
} from "@cf-stumble/pi";
import { compactThread, needsCompaction } from "./compaction.js";
import { composeSystemPrompt, loadTurnInstructions } from "./instructions.js";
import { createRouteModels } from "./route-models.js";
import {
  GENERATION_0_COMPACTION,
  GENERATION_0_SYSTEM_PROMPT,
  MAX_MODEL_CALLS,
} from "./turn-policy.js";
import type { CompactionPolicy } from "./compaction.js";

export type PiAgentTurnState = Readonly<
  Pick<AgentState, "systemPrompt" | "model" | "thinkingLevel" | "messages">
>;

export type PiAgentTurnProblem = Readonly<{
  code: "model-call-limit" | "model-error";
}>;

export type PiAgentTurnOutcome =
  | Readonly<{ ok: true; state: PiAgentTurnState }>
  | Readonly<{ ok: false; problem: PiAgentTurnProblem; state: PiAgentTurnState }>;

export type PiAgentTurnRequest = Readonly<{
  prompt: string;
  state: PiAgentTurnState;
  env: ExecutionEnv;
  streamFn: StreamFn;
  /** Called for every Pi lifecycle event, so a caller can publish the turn while it runs. */
  onEvent?: (event: AgentEvent) => void;
  /** Aborts the run in progress. A turn already past its last model call ignores it. */
  signal?: AbortSignal;
  /** Overrides this generation's compaction budget. A test uses it to force compaction. */
  compaction?: CompactionPolicy;
}>;

export function createPiAgentTurnState(model: AgentState["model"]): PiAgentTurnState {
  return {
    systemPrompt: GENERATION_0_SYSTEM_PROMPT,
    model,
    thinkingLevel: "off",
    messages: [],
  };
}

function bindExecutionTool(
  tool: AgentHarnessTool<ExecutionToolContext>,
  context: ExecutionToolContext,
): AgentTool {
  return {
    ...tool,
    execute: (toolCallId, params, signal, onUpdate) =>
      tool.execute(toolCallId, params, signal, onUpdate, context),
  };
}

function executionTools(context: ExecutionToolContext): AgentTool[] {
  return [
    bindExecutionTool(createReadTool(), context),
    bindExecutionTool(createWriteTool(), context),
    bindExecutionTool(createEditTool(), context),
    bindExecutionTool(createBashTool(), context),
  ];
}

function handoffState(agent: Agent): PiAgentTurnState {
  return {
    systemPrompt: agent.state.systemPrompt,
    model: agent.state.model,
    thinkingLevel: agent.state.thinkingLevel,
    messages: agent.state.messages,
  };
}

/**
 * The prompt this turn sends: this generation's own instructions plus whatever the workspace and
 * the selected repository currently say.
 *
 * It is rebuilt from {@link GENERATION_0_SYSTEM_PROMPT} on every turn rather than continued from
 * the saved state, because the saved prompt is last turn's answer to this same question. Rebuilding
 * is what lets a re-provisioned workspace, an edited `AGENTS.md`, or a replaced generation change
 * the instructions of a conversation that is already running.
 */
async function turnSystemPrompt(request: PiAgentTurnRequest): Promise<string> {
  const instructions = await loadTurnInstructions(request.env, request.signal);
  return composeSystemPrompt(GENERATION_0_SYSTEM_PROMPT, instructions);
}

/**
 * The conversation this turn starts from, compacted first when it has outgrown this generation's
 * declared budget. Compaction happens before the turn rather than between its model calls because
 * Pi's `Agent` transforms the context it sends without changing the messages it hands back, and a
 * compaction the thread does not keep would be paid for again on every later turn.
 */
async function startingMessages(request: PiAgentTurnRequest): Promise<readonly AgentMessage[]> {
  const messages = request.state.messages;
  const policy = request.compaction ?? GENERATION_0_COMPACTION;
  if (!needsCompaction(messages, policy)) return messages;

  const compacted = await compactThread(
    messages,
    createRouteModels(request.streamFn),
    request.state.model,
    policy,
    request.signal,
  );
  return compacted ?? messages;
}

export async function runPiAgentTurn(request: PiAgentTurnRequest): Promise<PiAgentTurnOutcome> {
  const context = { env: request.env } satisfies ExecutionToolContext;
  let reachedCallLimit = false;
  let modelCalls = 0;
  const agent = new Agent({
    initialState: {
      ...request.state,
      systemPrompt: await turnSystemPrompt(request),
      messages: [...(await startingMessages(request))],
      tools: executionTools(context),
    },
    // Pi's own message conversion, so a compaction summary reaches the model as the summary block
    // Pi defines. The agent's default conversion drops every role it does not send verbatim, which
    // would silently discard exactly the message compaction just produced.
    convertToLlm,
    streamFn: request.streamFn,
    shouldStopAfterTurn: ({ toolResults }) => {
      modelCalls += 1;
      reachedCallLimit = modelCalls === MAX_MODEL_CALLS && toolResults.length > 0;
      return reachedCallLimit;
    },
  });

  const unsubscribe = request.onEvent === undefined ? undefined : agent.subscribe(request.onEvent);
  const abort = () => {
    agent.abort();
  };
  request.signal?.addEventListener("abort", abort);
  try {
    await agent.prompt(request.prompt);
  } finally {
    request.signal?.removeEventListener("abort", abort);
    unsubscribe?.();
  }

  const state = handoffState(agent);
  if (reachedCallLimit) {
    return { ok: false, problem: { code: "model-call-limit" }, state };
  }
  return agent.state.errorMessage === undefined
    ? { ok: true, state }
    : { ok: false, problem: { code: "model-error" }, state };
}
