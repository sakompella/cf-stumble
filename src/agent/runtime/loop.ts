import { assertNever } from "../../git/types.js";
import type {
  CapturedToolResult,
  PrimitiveCall as ReplayPrimitiveCall,
  PrimitiveResult as ReplayPrimitiveResult,
  RecordedModelResponse,
} from "../../replay/schema.js";
import {
  PRIMITIVE_KINDS,
  type PrimitiveCall as ToolPrimitiveCall,
  type PrimitiveKind,
  type PrimitiveResult as ToolPrimitiveResult,
} from "../../tools/index.js";
import type { AgentDefinition } from "./definition.js";
import { isModelSourceError } from "./model-errors.js";
import type { ModelResponseSource } from "./model.js";
import { parseAgentResponse } from "./protocol.js";
import type { ParsedToolCall } from "./protocol.js";
import type { TurnFailure } from "./types.js";

export type ToolExecution =
  | { readonly ok: true; readonly result: ReplayPrimitiveResult }
  | { readonly ok: false; readonly failure: TurnFailure };

export type LoopEnvironment = {
  readonly definition: AgentDefinition;
  readonly maxSteps: number;
  readonly requestModel: ModelResponseSource["requestModel"];
  readonly callPrimitive: (call: ToolPrimitiveCall) => Promise<ToolExecution>;
};

export type LoopResult =
  | {
      readonly status: "completed";
      readonly response: string;
      readonly trace: readonly ToolPrimitiveCall[];
    }
  | {
      readonly status: "failed";
      readonly failure: TurnFailure;
      readonly trace: readonly ToolPrimitiveCall[];
    };

export async function executeLoop(
  input: string,
  environment: LoopEnvironment,
): Promise<LoopResult> {
  const trace: ToolPrimitiveCall[] = [];
  const toolResults: ReplayPrimitiveResult[] = [];

  for (let step = 0; step < environment.maxSteps; step += 1) {
    const response = await requestModel(input, environment, toolResults, trace);
    if (!response.ok) {
      return response.failure;
    }

    const parsed = parseAgentResponse(response.response);
    if (!parsed.ok) {
      return {
        status: "failed",
        failure: { kind: "malformed-tool-call", detail: parsed.detail },
        trace,
      };
    }
    if (parsed.response.kind === "final") {
      return { status: "completed", response: parsed.response.content, trace };
    }

    for (const action of parsed.response.calls) {
      const parsedCall = primitiveCall(action);
      if (!parsedCall.ok) {
        return { status: "failed", failure: parsedCall.failure, trace };
      }
      trace.push(parsedCall.call);
      const execution = await environment.callPrimitive(parsedCall.call);
      if (!execution.ok) {
        return { status: "failed", failure: execution.failure, trace };
      }
      toolResults.push(execution.result);
    }
  }

  return {
    status: "failed",
    failure: { kind: "step-budget-exceeded", maxSteps: environment.maxSteps },
    trace,
  };
}

type RequestResult =
  | { readonly ok: true; readonly response: RecordedModelResponse }
  | { readonly ok: false; readonly failure: LoopResult };

async function requestModel(
  input: string,
  environment: LoopEnvironment,
  toolResults: readonly ReplayPrimitiveResult[],
  trace: readonly ToolPrimitiveCall[],
): Promise<RequestResult> {
  try {
    return {
      ok: true,
      response: await environment.requestModel({
        requestId: "executor",
        input,
        definition: environment.definition,
        toolResults,
      }),
    };
  } catch (error: unknown) {
    if (!isModelSourceError(error)) {
      throw error;
    }
    return {
      ok: false,
      failure: {
        status: "failed",
        failure:
          error.kind === "exhausted"
            ? { kind: "model-source-exhausted", detail: error.message }
            : { kind: "model-source-error", detail: error.message },
        trace,
      },
    };
  }
}

function primitiveCall(action: ParsedToolCall):
  | { readonly ok: true; readonly call: ToolPrimitiveCall }
  | { readonly ok: false; readonly failure: TurnFailure } {
  if (!isPrimitiveKind(action.name)) {
    return { ok: false, failure: { kind: "unknown-tool", name: action.name } };
  }
  if (!isRecord(action.arguments)) {
    return {
      ok: false,
      failure: malformedArguments(action.name).failure,
    };
  }

  switch (action.name) {
    case "read":
      return readCall(action.arguments);
    case "write":
      return writeCall(action.arguments);
    case "edit":
      return editCall(action.arguments);
    case "bash":
      return bashCall(action.arguments);
    default:
      return assertNever(action.name, "primitive kind");
  }
}

function readCall(argumentsObject: Record<string, unknown>):
  | { readonly ok: true; readonly call: ToolPrimitiveCall }
  | { readonly ok: false; readonly failure: TurnFailure } {
  const path = stringArgument(argumentsObject, "path");
  return path === undefined
    ? malformedArgument("read", "path")
    : { ok: true, call: { kind: "read", path } };
}

function writeCall(argumentsObject: Record<string, unknown>):
  | { readonly ok: true; readonly call: ToolPrimitiveCall }
  | { readonly ok: false; readonly failure: TurnFailure } {
  const path = stringArgument(argumentsObject, "path");
  const content = stringArgument(argumentsObject, "content");
  if (path === undefined) {
    return malformedArgument("write", "path");
  }
  return content === undefined
    ? malformedArgument("write", "content")
    : { ok: true, call: { kind: "write", path, content } };
}

function editCall(argumentsObject: Record<string, unknown>):
  | { readonly ok: true; readonly call: ToolPrimitiveCall }
  | { readonly ok: false; readonly failure: TurnFailure } {
  const path = stringArgument(argumentsObject, "path");
  const oldText = stringArgument(argumentsObject, "oldText");
  const newText = stringArgument(argumentsObject, "newText");
  if (path === undefined) {
    return malformedArgument("edit", "path");
  }
  if (oldText === undefined) {
    return malformedArgument("edit", "oldText");
  }
  return newText === undefined
    ? malformedArgument("edit", "newText")
    : { ok: true, call: { kind: "edit", path, oldText, newText } };
}

function bashCall(argumentsObject: Record<string, unknown>):
  | { readonly ok: true; readonly call: ToolPrimitiveCall }
  | { readonly ok: false; readonly failure: TurnFailure } {
  const command = stringArgument(argumentsObject, "command");
  return command === undefined
    ? malformedArgument("bash", "command")
    : { ok: true, call: { kind: "bash", command } };
}

function malformedArguments(
  name: PrimitiveKind,
): { readonly ok: false; readonly failure: TurnFailure } {
  return {
    ok: false,
    failure: {
      kind: "malformed-tool-call",
      detail: `tool ${JSON.stringify(name)} arguments must be an object`,
    },
  };
}

function malformedArgument(
  name: PrimitiveKind,
  argument: string,
): { readonly ok: false; readonly failure: TurnFailure } {
  return {
    ok: false,
    failure: {
      kind: "malformed-tool-call",
      detail: `tool ${JSON.stringify(name)} argument ${JSON.stringify(argument)} must be a string`,
    },
  };
}

function stringArgument(argumentsObject: Record<string, unknown>, name: string): string | undefined {
  const value = argumentsObject[name];
  return typeof value === "string" ? value : undefined;
}

function isPrimitiveKind(value: string): value is PrimitiveKind {
  return PRIMITIVE_KINDS.some((kind) => kind === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toReplayCall(call: ToolPrimitiveCall): ReplayPrimitiveCall {
  switch (call.kind) {
    case "read":
      return { kind: "read", path: call.path };
    case "write":
      return { kind: "write", path: call.path, content: call.content };
    case "edit":
      return { kind: "edit", path: call.path, oldText: call.oldText, newText: call.newText };
    case "bash":
      return { kind: "bash", command: call.command };
    default:
      return assertNever(call, "primitive call");
  }
}

export function capturedToolResult(
  call: ToolPrimitiveCall,
  result: ToolPrimitiveResult,
  workspaceAfter: readonly { readonly path: string; readonly content: string }[] | undefined,
): CapturedToolResult {
  const capturedCall = toReplayCall(call);
  const capturedResult = toReplayResult(result);
  if (call.kind === "bash") {
    if (workspaceAfter === undefined) {
      throw new TypeError("internal error: bash result has no workspace snapshot");
    }
    return { call: capturedCall, result: capturedResult, workspaceAfter };
  }
  return { call: capturedCall, result: capturedResult };
}

function toReplayResult(result: ToolPrimitiveResult): ReplayPrimitiveResult {
  if (!result.ok) {
    throw new TypeError("internal error: primitive failure cannot become a replay result");
  }
  switch (result.kind) {
    case "read":
      return { kind: "read", content: result.content };
    case "write":
      return { kind: "write", bytesWritten: result.bytesWritten };
    case "edit":
      return { kind: "edit", replacements: result.replacements };
    case "bash":
      return {
        kind: "bash",
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    default:
      return assertNever(result, "primitive result");
  }
}
