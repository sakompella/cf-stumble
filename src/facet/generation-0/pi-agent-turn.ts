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
import { PROJECT_TURN_DEADLINE_MINUTES } from "../../turn-budget.js";
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

type PiAgentTurnProblem = Readonly<{
  code: "model-call-limit" | "model-error";
}>;

export type PiAgentTurnOutcome =
  | Readonly<{ ok: true; state: PiAgentTurnState }>
  | Readonly<{ ok: false; problem: PiAgentTurnProblem; state: PiAgentTurnState }>;

type PiAgentTurnRequest = Readonly<{
  prompt: string;
  state: PiAgentTurnState;
  env: ExecutionEnv;
  streamFn: StreamFn;
  onEvent?: (event: AgentEvent) => void;
  /** Aborts the run in progress. A turn already past its last model call ignores it. */
  signal?: AbortSignal;
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

const PI_READ_IMAGE_CLAIM =
  "Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments.";

const TEXT_ONLY_READ_IMAGE_NOTE =
  "Supports text files. An image file returns only its type, because this model route carries text only.";

/**
 * The model route carries text only, so an image block in a tool result would fail the next model call,
 * and the saved failed turn would repeat that on every later turn.
 */
function textOnlyReadTool(): AgentHarnessTool<ExecutionToolContext> {
  const tool = createReadTool({
    imageProcessor: () =>
      Promise.resolve({
        ok: false,
        message:
          "[Image omitted: this model route carries text only. Use bash to inspect the file.]",
      }),
  });

  return {
    ...tool,
    description: tool.description.replace(PI_READ_IMAGE_CLAIM, TEXT_ONLY_READ_IMAGE_NOTE),
  };
}

function executionTools(context: ExecutionToolContext): AgentTool[] {
  return [
    bindExecutionTool(textOnlyReadTool(), context),
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

/** Rebuilt every turn, not continued from saved state, so a re-provisioned workspace or edited `AGENTS.md` reaches a running conversation. */
async function turnSystemPrompt(request: PiAgentTurnRequest): Promise<string> {
  const instructions = await loadTurnInstructions(request.env, request.signal);

  const turnContext = [
    `The selected project working directory is ${request.env.cwd}.`,
    "Commands and relative paths run there.",
    `This turn has a time budget of ${PROJECT_TURN_DEADLINE_MINUTES} minutes. Prefer focused checks that fit within it.`,
  ].join(" ");

  return composeSystemPrompt(`${GENERATION_0_SYSTEM_PROMPT} ${turnContext}`, instructions);
}

/**
 * Compacted before the turn, not between model calls: Pi's `Agent` transforms the context it sends
 * without changing the messages it returns, so an unkept compaction would be paid for every turn.
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
    // The default conversion drops roles it does not send verbatim, which would discard the compaction summary.
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
