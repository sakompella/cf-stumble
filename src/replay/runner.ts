import { ReplayAbort, replayAbort } from "./abort.js";
import { compareObservableEffects, type EffectsDifference } from "./comparison.js";
import type {
  CapturedToolResult,
  ObservableEffects,
  PrimitiveCall,
  PrimitiveResult,
  RecordedModelResponse,
  ReplaySession,
  WorkspaceTree,
} from "./schema.js";

export type ModelRequest = {
  readonly requestId: string;
};

export type AgentRunResult =
  | { readonly status: "completed" }
  | {
      readonly status: "inconclusive";
      readonly reason: "malformed-response";
      readonly detail: string;
    };

export interface ReplayRuntime {
  requestModel(request: ModelRequest): Promise<RecordedModelResponse>;
  callPrimitive(call: PrimitiveCall): Promise<PrimitiveResult>;
  now(): number;
  random(): number;
}

/** The seam for the agent loop; replay supplies every external interaction through the runtime. */
export interface ReplayAgentLoop {
  runTurn(input: string, runtime: ReplayRuntime): Promise<AgentRunResult>;
}

export type ReplayInconclusiveReason =
  | "tape-exhausted"
  | "unexpected-model-request"
  | "unused-tape"
  | "timeout"
  | "malformed-response"
  | "agent-error";

export type ReplayOutcome =
  | {
      readonly status: "PASS";
      readonly effects: ObservableEffects;
    }
  | {
      readonly status: "FAIL";
      readonly effects: ObservableEffects;
      readonly difference: EffectsDifference;
    }
  | {
      readonly status: "INCONCLUSIVE";
      readonly reason: ReplayInconclusiveReason;
      readonly detail: string;
      readonly effects: ObservableEffects;
    };

export type ReplayOptions = {
  readonly timeoutMs?: number;
};

function workspaceFromTree(tree: WorkspaceTree): Map<string, string> {
  return new Map(tree.map((file) => [file.path, file.content]));
}

function treeFromWorkspace(workspace: ReadonlyMap<string, string>): WorkspaceTree {
  return [...workspace.entries()]
    .map(([path, content]) => ({ path, content }))
    .toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function applyPrimitive(
  call: PrimitiveCall,
  captured: CapturedToolResult,
  workspace: Map<string, string>,
): void {
  switch (call.kind) {
    case "read":
      break;
    case "write":
      workspace.set(call.path, call.content);
      return;
    case "edit": {
      const current = workspace.get(call.path);
      if (current === undefined) {
        return;
      }
      const offset = current.indexOf(call.oldText);
      if (offset < 0) {
        return;
      }
      workspace.set(
        call.path,
        `${current.slice(0, offset)}${call.newText}${current.slice(offset + call.oldText.length)}`,
      );
      return;
    }
    case "bash":
      if (captured.workspaceAfter !== undefined) {
        workspace.clear();
        for (const file of captured.workspaceAfter) {
          workspace.set(file.path, file.content);
        }
      }
      break;
  }
}

class ReplayRuntimeImpl implements ReplayRuntime {
  private readonly workspace: Map<string, string>;
  private readonly trace: PrimitiveCall[] = [];
  private randomState: number;
  private turnIndex = 0;
  private modelIndex = 0;
  private toolIndex = 0;

  private readonly session: ReplaySession;

  constructor(session: ReplaySession) {
    this.session = session;
    this.workspace = workspaceFromTree(session.initialWorkspace);
    this.randomState = session.seed === 0 ? 0x6d2b79f5 : session.seed;
  }

  startTurn(): void {
    this.modelIndex = 0;
    this.toolIndex = 0;
  }

  finishTurn(): void {
    const turn = this.currentTurn();
    if (this.modelIndex !== turn.modelResponses.length) {
      throw replayAbort(
        "unused-tape",
        `turn ${this.turnIndex} left ${turn.modelResponses.length - this.modelIndex} model response(s) unused`,
      );
    }
    if (this.toolIndex !== turn.capturedToolResults.length) {
      throw replayAbort(
        "unused-tape",
        `turn ${this.turnIndex} left ${turn.capturedToolResults.length - this.toolIndex} tool result(s) unused`,
      );
    }
    this.turnIndex += 1;
  }

  requestModel(request: ModelRequest): Promise<RecordedModelResponse> {
    const entry = this.currentTurn().modelResponses[this.modelIndex];
    if (entry === undefined) {
      throw replayAbort(
        "tape-exhausted",
        `turn ${this.turnIndex} requested model response ${this.modelIndex}, but the tape is exhausted`,
      );
    }
    this.modelIndex += 1;
    if (entry.requestId !== request.requestId) {
      throw replayAbort(
        "unexpected-model-request",
        `turn ${this.turnIndex} requested ${JSON.stringify(request.requestId)}, expected ${JSON.stringify(entry.requestId)}`,
      );
    }
    return Promise.resolve(entry);
  }

  callPrimitive(call: PrimitiveCall): Promise<PrimitiveResult> {
    const captured = this.currentTurn().capturedToolResults[this.toolIndex];
    if (captured === undefined) {
      throw replayAbort(
        "tape-exhausted",
        `turn ${this.turnIndex} requested tool result ${this.toolIndex}, but the tape is exhausted`,
      );
    }
    this.toolIndex += 1;
    this.trace.push(call);
    applyPrimitive(call, captured, this.workspace);
    return Promise.resolve(captured.result);
  }

  now(): number {
    return this.session.clock.nowMs;
  }

  random(): number {
    let state = this.randomState;
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    this.randomState = state >>> 0;
    return this.randomState / 0x1_0000_0000;
  }

  currentEffects(): ObservableEffects {
    return {
      trace: [...this.trace],
      finalWorkspace: treeFromWorkspace(this.workspace),
    };
  }

  private currentTurn() {
    const turn = this.session.turns[this.turnIndex];
    if (turn === undefined) {
      throw replayAbort("tape-exhausted", `requested missing turn ${this.turnIndex}`);
    }
    return turn;
  }
}

function errorDetail(error: Error | string): string {
  return error instanceof Error ? error.message : error;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(replayAbort("timeout", `replay exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (reason) => {
        clearTimeout(timer);
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      },
    );
  });
}

export async function runReplay(
  session: ReplaySession,
  agent: ReplayAgentLoop,
  options?: ReplayOptions,
): Promise<ReplayOutcome> {
  const runtime = new ReplayRuntimeImpl(session);
  const timeoutMs = options?.timeoutMs ?? 30_000;

  try {
    for (const turn of session.turns) {
      runtime.startTurn();
      const result = await withTimeout(agent.runTurn(turn.input, runtime), timeoutMs);
      if (result.status === "inconclusive") {
        return {
          status: "INCONCLUSIVE",
          reason: result.reason,
          detail: result.detail,
          effects: runtime.currentEffects(),
        };
      }
      runtime.finishTurn();
    }

    const effects = runtime.currentEffects();
    const comparison = compareObservableEffects(session.expectedEffects, effects);
    if (comparison.equal) {
      return { status: "PASS", effects };
    }
    return { status: "FAIL", effects, difference: comparison.difference };
  } catch (error: unknown) {
    if (error instanceof ReplayAbort) {
      return {
        status: "INCONCLUSIVE",
        reason: error.reason,
        detail: error.message,
        effects: runtime.currentEffects(),
      };
    }
    const detail = error instanceof Error ? error : String(error);
    return {
      status: "INCONCLUSIVE",
      reason: "agent-error",
      detail: `agent loop failed: ${errorDetail(detail)}`,
      effects: runtime.currentEffects(),
    };
  }
}

export { REPLAY_SCHEMA_VERSION } from "./schema.js";
export type { ReplaySession } from "./schema.js";
