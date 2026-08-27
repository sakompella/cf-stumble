import { assertNever } from "../git/types.js";
import type { AgentDefinition, TurnFailure, TurnResult } from "../agent/runtime/index.js";
import type { CapturedToolResult } from "../replay/schema.js";
import type { PrimitiveCall, PrimitiveFailure } from "../tools/index.js";
import { parseWorkspacePath } from "../tools/index.js";
import type { Workspace, WorkspaceFileContent } from "../tools/index.js";
import type { PreflightCapability, PreflightCheck, PreflightProbe } from "./preflight.js";
import { callForProbe } from "./preflight-probes.js";

export function verifyProbe(
  probe: PreflightProbe,
  definition: AgentDefinition,
  turn: Extract<TurnResult, { readonly status: "completed" }>,
  workspace: Workspace,
): Promise<PreflightCheck> {
  const expectedCall = callForProbe(probe, definition);
  const actualCall = turn.trace[0];
  if (
    turn.trace.length !== 1 ||
    actualCall === undefined ||
    !callsMatch(actualCall, expectedCall)
  ) {
    return Promise.resolve(
      fail(probe.capability, `expected exactly one ${expectedCall.kind} call`),
    );
  }

  const transcriptTurn = turn.transcript.turns[0];
  const captured = transcriptTurn?.capturedToolResults[0];
  if (
    transcriptTurn === undefined ||
    transcriptTurn.capturedToolResults.length !== 1 ||
    captured === undefined
  ) {
    return Promise.resolve(fail(probe.capability, "executor returned no captured tool result"));
  }

  switch (probe.capability) {
    case "read":
      return Promise.resolve(verifyRead(probe, captured.result));
    case "write":
      return verifyWrittenFile(probe, captured.result, workspace);
    case "edit":
      return verifyEditedFile(probe, captured.result, workspace);
    case "bash":
      return Promise.resolve(verifyBash(probe, captured.result));
    case "self-edit":
      return verifySelfEdit(probe, captured.result, workspace, definition);
    default:
      return assertNever(probe, "preflight probe verification");
  }
}

function callsMatch(actual: PrimitiveCall, expected: PrimitiveCall): boolean {
  if (actual.kind !== expected.kind) {
    return false;
  }
  switch (expected.kind) {
    case "read":
      return actual.kind === "read" && actual.path === expected.path;
    case "write":
      return (
        actual.kind === "write" &&
        actual.path === expected.path &&
        actual.content === expected.content
      );
    case "edit":
      return (
        actual.kind === "edit" &&
        actual.path === expected.path &&
        actual.oldText === expected.oldText &&
        actual.newText === expected.newText
      );
    case "bash":
      return actual.kind === "bash" && actual.command === expected.command;
    default:
      return assertNever(expected, "preflight expected call");
  }
}

function verifyRead(
  probe: Extract<PreflightProbe, { readonly capability: "read" }>,
  result: CapturedToolResult["result"],
): PreflightCheck {
  if (!isReadResult(result) || result.content !== probe.content) {
    return fail(probe.capability, "expected read to return the seeded content");
  }
  return pass(probe.capability);
}

function verifyWrittenFile(
  probe: Extract<PreflightProbe, { readonly capability: "write" }>,
  result: CapturedToolResult["result"],
  workspace: Workspace,
): Promise<PreflightCheck> {
  if (!isWriteResult(result)) {
    return Promise.resolve(fail(probe.capability, "expected a structured write result"));
  }
  return verifyTextFile(workspace, probe.path, probe.content, probe.capability, "write");
}

function verifyEditedFile(
  probe: Extract<PreflightProbe, { readonly capability: "edit" }>,
  result: CapturedToolResult["result"],
  workspace: Workspace,
): Promise<PreflightCheck> {
  if (!isEditResult(result) || result.replacements !== 1) {
    return Promise.resolve(fail(probe.capability, "expected exactly one edit replacement"));
  }
  const expected = probe.initialContent.replace(probe.oldText, probe.newText);
  return verifyTextFile(workspace, probe.path, expected, probe.capability, "edit");
}

function verifyBash(
  probe: Extract<PreflightProbe, { readonly capability: "bash" }>,
  result: CapturedToolResult["result"],
): PreflightCheck {
  if (!isBashResult(result) || result.exitCode !== 0) {
    return fail(probe.capability, "expected bash to return exit code 0");
  }
  return pass(probe.capability);
}

function verifySelfEdit(
  probe: Extract<PreflightProbe, { readonly capability: "self-edit" }>,
  result: CapturedToolResult["result"],
  workspace: Workspace,
  definition: AgentDefinition,
): Promise<PreflightCheck> {
  if (!isEditResult(result) || result.replacements !== 1) {
    return Promise.resolve(fail(probe.capability, "expected exactly one edit replacement"));
  }
  return verifyTextFile(
    workspace,
    probe.path,
    `${definition.systemPrompt}${probe.suffix}`,
    probe.capability,
    "self-edit",
  );
}

async function verifyTextFile(
  workspace: Workspace,
  path: string,
  expected: string,
  capability: Exclude<PreflightCapability, "materialization">,
  operation: string,
): Promise<PreflightCheck> {
  let content: WorkspaceFileContent | undefined;
  try {
    content = await workspace.readFile(parseWorkspacePath(path));
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return inconclusive(capability, `workspace ${operation} check failed: ${detail}`);
  }
  if (content === undefined) {
    return fail(capability, `expected ${operation} to create or update ${JSON.stringify(path)}`);
  }
  if (!isTextContent(content) || content !== expected) {
    return fail(capability, `expected ${operation} to produce the expected content`);
  }
  return pass(capability);
}

export function failedTurn(
  capability: Exclude<PreflightCapability, "materialization">,
  failure: TurnFailure,
): PreflightCheck {
  switch (failure.kind) {
    case "primitive-failure":
      return isHarnessPrimitiveError(failure.error)
        ? inconclusive(capability, primitiveFailureDetail(failure.error))
        : fail(capability, primitiveFailureDetail(failure.error));
    case "model-source-exhausted":
    case "model-source-error":
    case "transcript-error":
      return inconclusive(capability, failure.detail);
    case "malformed-tool-call":
      return fail(capability, failure.detail);
    case "unknown-tool":
      return fail(capability, `unknown tool ${JSON.stringify(failure.name)}`);
    case "step-budget-exceeded":
      return fail(capability, `turn exceeded its ${failure.maxSteps}-step budget`);
    default:
      return assertNever(failure, "preflight turn failure");
  }
}

function isHarnessPrimitiveError(error: PrimitiveFailure["error"]): boolean {
  switch (error.kind) {
    case "workspace-error":
    case "timeout":
    case "invalid-timeout":
      return true;
    case "invalid-path":
    case "file-not-found":
    case "binary-file":
    case "empty-search":
    case "no-match":
    case "ambiguous-match":
      return false;
    default:
      return assertNever(error, "preflight primitive failure");
  }
}

function primitiveFailureDetail(error: PrimitiveFailure["error"]): string {
  switch (error.kind) {
    case "invalid-path":
      return `invalid path ${JSON.stringify(error.path)} (${error.reason})`;
    case "workspace-error":
      return `workspace error during ${error.operation}: ${error.detail}`;
    case "file-not-found":
      return `file ${JSON.stringify(error.path)} was not found`;
    case "binary-file":
      return `file ${JSON.stringify(error.path)} is binary`;
    case "empty-search":
      return "edit search text must not be empty";
    case "no-match":
      return "expected exactly one match, found none";
    case "ambiguous-match":
      return `expected exactly one match, found ${error.occurrences}`;
    case "timeout":
      return `workspace command timed out after ${error.timeoutMs}ms`;
    case "invalid-timeout":
      return `invalid bash timeout ${error.timeoutMs}`;
    default:
      return assertNever(error, "preflight primitive failure detail");
  }
}

function pass(capability: Exclude<PreflightCapability, "materialization">): PreflightCheck {
  return { capability, status: "PASS" };
}

function fail(
  capability: Exclude<PreflightCapability, "materialization">,
  detail: string,
): PreflightCheck {
  return { capability, status: "FAIL", detail: `${capability}: ${detail}` };
}

function inconclusive(
  capability: Exclude<PreflightCapability, "materialization">,
  detail: string,
): PreflightCheck {
  return { capability, status: "INCONCLUSIVE", detail: `${capability}: ${detail}` };
}

function isTextContent(content: WorkspaceFileContent): content is string {
  return typeof content === "string";
}

type ReadResult = { readonly kind: "read"; readonly content: string };
type WriteResult = { readonly kind: "write"; readonly bytesWritten: number };
type EditResult = { readonly kind: "edit"; readonly replacements: number };
type BashResult = {
  readonly kind: "bash";
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

function isReadResult(result: CapturedToolResult["result"]): result is ReadResult {
  return result.kind === "read" && "content" in result && typeof result.content === "string";
}

function isWriteResult(result: CapturedToolResult["result"]): result is WriteResult {
  return (
    result.kind === "write" && "bytesWritten" in result && typeof result.bytesWritten === "number"
  );
}

function isEditResult(result: CapturedToolResult["result"]): result is EditResult {
  return (
    result.kind === "edit" && "replacements" in result && typeof result.replacements === "number"
  );
}

function isBashResult(result: CapturedToolResult["result"]): result is BashResult {
  return result.kind === "bash" && "exitCode" in result && typeof result.exitCode === "number";
}
