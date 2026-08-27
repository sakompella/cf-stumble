import { Result, isPanic } from "better-result";
import {
  REPLAY_SCHEMA_VERSION,
  type CapturedToolResult,
  type RecordedModelResponse,
  type ReplaySession,
  type WorkspaceTree,
} from "../../replay/schema.js";
import {
  executePrimitive,
  type PrimitiveCall as ToolPrimitiveCall,
  type PrimitiveOptions,
} from "../../tools/index.js";
import type { Workspace } from "../../tools/types.js";
import type { AgentDefinition } from "./definition.js";
import type { AgentModelRequest, ModelResponseSource } from "./model.js";
import {
  capturedToolResult,
  executeLoop,
  toReplayCall,
  type LoopEnvironment,
  type LoopResult,
} from "./loop.js";
import { TranscriptSnapshotError } from "./model-errors.js";
import { errorDetail, recordingOptionsFor, snapshotWorkspace } from "./transcript.js";
import type { ExecuteTurnOptions, TurnResult } from "./types.js";

export async function executeLiveTurn(
  definition: AgentDefinition,
  maxSteps: number,
  primitiveOptions: PrimitiveOptions | undefined,
  input: string,
  source: ModelResponseSource,
  workspace: Workspace,
  options: ExecuteTurnOptions,
): Promise<TurnResult> {
  const recordingOptions = recordingOptionsFor(options);
  const initial = await safeSnapshot(workspace);
  if (Result.isError(initial)) {
    return transcriptFailure(initial.error);
  }

  const modelResponses: RecordedModelResponse[] = [];
  const capturedToolResults: CapturedToolResult[] = [];
  const loop = await executeLoop(
    input,
    liveEnvironment(
      definition,
      maxSteps,
      primitiveOptions,
      source,
      workspace,
      modelResponses,
      capturedToolResults,
    ),
  );
  if (loop.status === "failed") {
    return loop;
  }
  return makeCompletedTurn(
    input,
    recordingOptions,
    initial.value,
    modelResponses,
    capturedToolResults,
    loop,
    workspace,
  );
}

async function safeSnapshot(
  workspace: Workspace,
): Promise<Result<WorkspaceTree, TranscriptSnapshotError>> {
  try {
    return Result.ok(await snapshotWorkspace(workspace));
  } catch (error: unknown) {
    if (isPanic(error)) {
      throw error;
    }
    return Result.err(
      new TranscriptSnapshotError({
        detail: errorDetail(error instanceof Error ? error : String(error)),
        cause: error,
      }),
    );
  }
}

function liveEnvironment(
  definition: AgentDefinition,
  maxSteps: number,
  primitiveOptions: PrimitiveOptions | undefined,
  source: ModelResponseSource,
  workspace: Workspace,
  modelResponses: RecordedModelResponse[],
  capturedToolResults: CapturedToolResult[],
): LoopEnvironment {
  return {
    definition,
    maxSteps,
    requestModel: (request) => recordModelResponse(source, request, modelResponses),
    callPrimitive: (call) =>
      executeLiveTool(call, workspace, primitiveOptions, capturedToolResults),
  };
}

function recordModelResponse(
  source: ModelResponseSource,
  request: AgentModelRequest,
  responses: RecordedModelResponse[],
): Promise<RecordedModelResponse> {
  return source.requestModel(request).then((response) => {
    responses.push({ ...response });
    return response;
  });
}

async function executeLiveTool(
  call: ToolPrimitiveCall,
  workspace: Workspace,
  primitiveOptions: PrimitiveOptions | undefined,
  capturedToolResults: CapturedToolResult[],
) {
  const result = await executePrimitive(call, workspace, primitiveOptions);
  if (Result.isError(result)) {
    return {
      ok: false as const,
      failure: result.error,
    };
  }

  let workspaceAfter: WorkspaceTree | undefined;
  if (call.kind === "bash") {
    const snapshot = await safeSnapshot(workspace);
    if (Result.isError(snapshot)) {
      return { ok: false as const, failure: snapshot.error };
    }
    workspaceAfter = snapshot.value;
  }
  const captured = capturedToolResult(call, result.value, workspaceAfter);
  capturedToolResults.push(captured);
  return { ok: true as const, result: captured.result };
}

async function makeCompletedTurn(
  input: string,
  recordingOptions: { readonly name: string; readonly seed: number; readonly nowMs: number },
  initialWorkspace: WorkspaceTree,
  modelResponses: readonly RecordedModelResponse[],
  capturedToolResults: readonly CapturedToolResult[],
  loop: Extract<LoopResult, { readonly status: "completed" }>,
  workspace: Workspace,
): Promise<TurnResult> {
  const final = await safeSnapshot(workspace);
  if (Result.isError(final)) {
    return transcriptFailure(final.error, loop.trace);
  }
  const transcript: ReplaySession = {
    schemaVersion: REPLAY_SCHEMA_VERSION,
    name: recordingOptions.name,
    seed: recordingOptions.seed,
    clock: { nowMs: recordingOptions.nowMs },
    initialWorkspace,
    turns: [{ input, modelResponses, capturedToolResults }],
    expectedEffects: {
      trace: loop.trace.map(toReplayCall),
      finalWorkspace: final.value,
    },
  };
  return { status: "completed", response: loop.response, trace: loop.trace, transcript };
}

function transcriptFailure(
  failure: TranscriptSnapshotError,
  trace: readonly ToolPrimitiveCall[] = [],
): TurnResult {
  return { status: "failed", failure, trace };
}
