import type {
  AgentRunResult,
  ReplayAgentLoop,
  ReplayRuntime,
} from "../../replay/index.js";
import type { PrimitiveOptions } from "../../tools/index.js";
import type { Workspace } from "../../tools/types.js";
import type { AgentDefinition } from "./definition.js";
import { executeLiveTurn } from "./live-turn.js";
import { executeLoop, toReplayCall } from "./loop.js";
import { recordedSourceFromReplayRuntime } from "./replay-source.js";
import type { ModelResponseSource } from "./model.js";
import { describeFailure } from "./transcript.js";
import type {
  AgentExecutorOptions,
  ExecuteTurnOptions,
  TurnResult,
} from "./types.js";

export const DEFAULT_MAX_STEPS = 32;
export { DEFAULT_MODEL_REQUEST_ID } from "./model.js";

/** The executor used by both live turns and the replay validation runner. */
export class AgentExecutor implements ReplayAgentLoop {
  private readonly definition: AgentDefinition;
  private readonly maxSteps: number;
  private readonly primitiveOptions: PrimitiveOptions | undefined;

  constructor(definition: AgentDefinition, options: AgentExecutorOptions = {}) {
    const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0) {
      throw new TypeError(`agent maxSteps must be a positive safe integer, got ${maxSteps}`);
    }
    this.definition = definition;
    this.maxSteps = maxSteps;
    this.primitiveOptions = options.primitiveOptions;
  }

  /** Execute a turn against the caller's workspace and model source. */
  executeTurn(
    input: string,
    source: ModelResponseSource,
    workspace: Workspace,
    options: ExecuteTurnOptions = {},
  ): Promise<TurnResult> {
    return executeLiveTurn(
      this.definition,
      this.maxSteps,
      this.primitiveOptions,
      input,
      source,
      workspace,
      options,
    );
  }

  /** Adapt the same loop to the replay runner's recorded runtime seam. */
  async runTurn(input: string, runtime: ReplayRuntime): Promise<AgentRunResult> {
    const recordedSource = recordedSourceFromReplayRuntime(runtime);
    const loop = await executeLoop(input, {
      definition: this.definition,
      maxSteps: this.maxSteps,
      requestModel: (request) => recordedSource.requestModel(request),
      callPrimitive: async (call) => ({
        ok: true,
        result: await runtime.callPrimitive(toReplayCall(call)),
      }),
    });
    if (loop.status === "completed") {
      return { status: "completed" };
    }
    return {
      status: "inconclusive",
      reason: "malformed-response",
      detail: describeFailure(loop.failure),
    };
  }
}

export type {
  AgentExecutorOptions,
  ExecuteTurnOptions,
  TurnFailure,
  TurnResult,
} from "./types.js";
