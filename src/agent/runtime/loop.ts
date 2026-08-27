import { Result } from "better-result";
import { isJsonObjectValue, type JsonObject, type JsonValue } from "../../json.js";
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
  type PrimitiveSuccess as ToolPrimitiveSuccess,
} from "../../tools/index.js";
import type { AgentDefinition } from "./definition.js";
import {
  MalformedToolCallError,
  ModelSourceExhaustedError,
  ModelSourceFailedError,
  StepBudgetExceededError,
  UnknownToolError,
} from "./model-errors.js";
import { DEFAULT_MODEL_REQUEST_ID, type ModelResponseSource } from "./model.js";
import { parseAgentResponse } from "./protocol.js";
import type { ParsedToolCall } from "./protocol.js";
import type { TurnFailure } from "./types.js";

/** Outcome of decoding one tool call from model output: a domain call, or why it was rejected. */
type PrimitiveCallParse = Result<ToolPrimitiveCall, MalformedToolCallError | UnknownToolError>;

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
    const response = await requestModel(input, environment, toolResults);
    if (Result.isError(response)) {
      return { status: "failed", failure: response.error, trace };
    }

    const parsed = parseAgentResponse(response.value);
    if (Result.isError(parsed)) {
      return { status: "failed", failure: parsed.error, trace };
    }
    if (parsed.value.kind === "final") {
      return { status: "completed", response: parsed.value.content, trace };
    }

    for (const action of parsed.value.calls) {
      const parsedCall = primitiveCall(action);
      if (Result.isError(parsedCall)) {
        return { status: "failed", failure: parsedCall.error, trace };
      }
      trace.push(parsedCall.value);
      const execution = await environment.callPrimitive(parsedCall.value);
      if (!execution.ok) {
        return { status: "failed", failure: execution.failure, trace };
      }
      toolResults.push(execution.result);
    }
  }

  return {
    status: "failed",
    failure: new StepBudgetExceededError({ maxSteps: environment.maxSteps }),
    trace,
  };
}

async function requestModel(
  input: string,
  environment: LoopEnvironment,
  toolResults: readonly ReplayPrimitiveResult[],
): Promise<Result<RecordedModelResponse, ModelSourceExhaustedError | ModelSourceFailedError>> {
  try {
    return Result.ok(
      await environment.requestModel({
        requestId: DEFAULT_MODEL_REQUEST_ID,
        input,
        definition: environment.definition,
        toolResults,
      }),
    );
  } catch (error) {
    if (ModelSourceExhaustedError.is(error) || ModelSourceFailedError.is(error)) {
      return Result.err(error);
    }
    throw error;
  }
}

function primitiveCall(action: ParsedToolCall): PrimitiveCallParse {
  if (!isPrimitiveKind(action.name)) {
    return Result.err(new UnknownToolError({ toolName: action.name }));
  }
  if (!isJsonObjectValue(action.arguments)) {
    return malformedArguments(action.name);
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

function readCall(argumentsObject: JsonObject): PrimitiveCallParse {
  const path = stringArgument(argumentsObject, "path");
  return path === undefined ? malformedArgument("read", "path") : Result.ok({ kind: "read", path });
}

function writeCall(argumentsObject: JsonObject): PrimitiveCallParse {
  const path = stringArgument(argumentsObject, "path");
  const content = stringArgument(argumentsObject, "content");
  if (path === undefined) {
    return malformedArgument("write", "path");
  }
  return content === undefined
    ? malformedArgument("write", "content")
    : Result.ok({ kind: "write", path, content });
}

function editCall(argumentsObject: JsonObject): PrimitiveCallParse {
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
    : Result.ok({ kind: "edit", path, oldText, newText });
}

function bashCall(argumentsObject: JsonObject): PrimitiveCallParse {
  const command = stringArgument(argumentsObject, "command");
  return command === undefined
    ? malformedArgument("bash", "command")
    : Result.ok({ kind: "bash", command });
}

function malformedArguments(name: PrimitiveKind): PrimitiveCallParse {
  return Result.err(
    new MalformedToolCallError({
      detail: `tool ${JSON.stringify(name)} arguments must be an object`,
    }),
  );
}

function malformedArgument(name: PrimitiveKind, argument: string): PrimitiveCallParse {
  return Result.err(
    new MalformedToolCallError({
      detail: `tool ${JSON.stringify(name)} argument ${JSON.stringify(argument)} must be a string`,
    }),
  );
}

function stringArgument(argumentsObject: JsonObject, name: string): string | undefined {
  const value = argumentsObject[name];
  return isString(value) ? value : undefined;
}

function isPrimitiveKind(value: string): value is PrimitiveKind {
  return PRIMITIVE_KINDS.some((kind) => kind === value);
}

function isString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
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
  result: ToolPrimitiveSuccess,
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

/**
 * A replay transcript records what happened, and a failed primitive produces no captured result.
 * The parameter type is the success type, so handing this a failure is no longer representable —
 * the guard this function used to need is gone.
 */
function toReplayResult(result: ToolPrimitiveSuccess): ReplayPrimitiveResult {
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
