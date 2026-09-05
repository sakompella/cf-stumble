import {
  Agent,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@cf-stumble/pi";
import type {
  AgentEvent,
  AgentHarnessTool,
  AgentState,
  AgentTool,
  ExecutionEnv,
  ExecutionToolContext,
  StreamFn,
} from "@cf-stumble/pi";
import { GENERATION_0_SYSTEM_PROMPT, MAX_MODEL_CALLS } from "./turn.js";

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

export async function runPiAgentTurn(request: PiAgentTurnRequest): Promise<PiAgentTurnOutcome> {
  const context = { env: request.env } satisfies ExecutionToolContext;
  let reachedCallLimit = false;
  let modelCalls = 0;
  const agent = new Agent({
    initialState: {
      ...request.state,
      messages: [...request.state.messages],
      tools: executionTools(context),
    },
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
