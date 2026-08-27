import { assertNever } from "../git/types.js";
import type { AgentDefinition, TurnFailure, TurnResult } from "../agent/runtime/index.js";
import type { CapturedToolResult } from "../replay/schema.js";
import type { PrimitiveCall, PrimitiveError } from "../tools/index.js";
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
  // Probe paths are our own constants, so an invalid one is a defect in this module rather than a
  // condition to report. Parsed outside the try so a panic is not mistaken for a workspace fault.
  const probePath = parseWorkspacePath(path).unwrap(
    `preflight probe declares an invalid workspace path: ${JSON.stringify(path)}`,
  );

  let content: WorkspaceFileContent | undefined;
  try {
    content = await workspace.readFile(probePath);
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

/**
 * Whether the harness failed rather than the candidate.
 *
 * This split is the reason preflight has three outcomes instead of two: charging a candidate with
 * a FAIL for the harness's own broken workspace would ratchet in a regression the candidate never
 * caused. A harness fault is INCONCLUSIVE, which blocks promotion without recording a regression.
 *
 * Exhaustive over `PrimitiveError`, so adding a primitive failure forces a decision here rather
 * than defaulting into one.
 */
function isHarnessPrimitiveError(error: PrimitiveError): boolean {
  return error.match<PrimitiveError, boolean>({
    WorkspaceOperationError: () => true,
    CommandTimeoutError: () => true,
    InvalidCommandTimeoutError: () => true,
    InvalidWorkspacePathError: () => false,
    WorkspaceFileNotFoundError: () => false,
    BinaryFileError: () => false,
    EmptyEditSearchError: () => false,
    EditNoMatchError: () => false,
    EditAmbiguousMatchError: () => false,
  });
}

/**
 * The preflight-facing wording for a primitive failure. Built here rather than read off the
 * error's own `message`, which is developer-facing and free to change.
 */
function primitiveFailureDetail(error: PrimitiveError): string {
  return error.match<PrimitiveError, string>({
    InvalidWorkspacePathError: (e) => `invalid path ${JSON.stringify(e.path)} (${e.rejection})`,
    WorkspaceOperationError: (e) => `workspace error during ${e.operation}: ${e.detail}`,
    WorkspaceFileNotFoundError: (e) => `file ${JSON.stringify(e.path)} was not found`,
    BinaryFileError: (e) => `file ${JSON.stringify(e.path)} is binary`,
    EmptyEditSearchError: () => "edit search text must not be empty",
    EditNoMatchError: () => "expected exactly one match, found none",
    EditAmbiguousMatchError: (e) => `expected exactly one match, found ${e.occurrences}`,
    CommandTimeoutError: (e) => `workspace command timed out after ${e.timeoutMs}ms`,
    InvalidCommandTimeoutError: (e) => `invalid bash timeout ${e.timeoutMs}`,
  });
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
