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
import { errorDetail, recordingOptionsFor, snapshotWorkspace } from "./transcript.js";
import type { ExecuteTurnOptions, TurnFailure, TurnResult } from "./types.js";

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
  if (!initial.ok) {
    return transcriptFailure(initial.detail);
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
    initial.workspace,
    modelResponses,
    capturedToolResults,
    loop,
    workspace,
  );
}

type SnapshotResult =
  | { readonly ok: true; readonly workspace: WorkspaceTree }
  | { readonly ok: false; readonly detail: string };

async function safeSnapshot(workspace: Workspace): Promise<SnapshotResult> {
  try {
    return { ok: true, workspace: await snapshotWorkspace(workspace) };
  } catch (error: unknown) {
    return { ok: false, detail: errorDetail(error instanceof Error ? error : String(error)) };
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
  if (!result.ok) {
    return {
      ok: false as const,
      failure: { kind: "primitive-failure", call, error: result.error } satisfies TurnFailure,
    };
  }

  let workspaceAfter: WorkspaceTree | undefined;
  if (call.kind === "bash") {
    const snapshot = await safeSnapshot(workspace);
    if (!snapshot.ok) {
      return {
        ok: false as const,
        failure: { kind: "transcript-error", detail: snapshot.detail } satisfies TurnFailure,
      };
    }
    workspaceAfter = snapshot.workspace;
  }
  const captured = capturedToolResult(call, result, workspaceAfter);
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
  if (!final.ok) {
    return transcriptFailure(final.detail, loop.trace);
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
      finalWorkspace: final.workspace,
    },
  };
  return { status: "completed", response: loop.response, trace: loop.trace, transcript };
}

function transcriptFailure(detail: string, trace: readonly ToolPrimitiveCall[] = []): TurnResult {
  return { status: "failed", failure: { kind: "transcript-error", detail }, trace };
}
