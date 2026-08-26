import { assertNever } from "../git/types.js";
import { prepareEdit, type EditMatchError } from "./edit.js";
import {
  validateWorkspacePath,
  type Workspace,
  type WorkspaceCommandResult,
  type WorkspacePathError,
} from "./types.js";

export const PRIMITIVE_KINDS = ["read", "write", "edit", "bash"] as const;
export type PrimitiveKind = (typeof PRIMITIVE_KINDS)[number];

export type ReadCall = {
  readonly kind: "read";
  readonly path: string;
};

export type WriteCall = {
  readonly kind: "write";
  readonly path: string;
  readonly content: string;
};

export type EditCall = {
  readonly kind: "edit";
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
};

export type BashCall = {
  readonly kind: "bash";
  readonly command: string;
};

/** The closed action space. Additions must update the exhaustive dispatcher below. */
export type PrimitiveCall = ReadCall | WriteCall | EditCall | BashCall;
export type Primitive = PrimitiveCall;

export type ReadResult = {
  readonly ok: true;
  readonly kind: "read";
  readonly content: string;
};

export type WriteResult = {
  readonly ok: true;
  readonly kind: "write";
  readonly bytesWritten: number;
};

export type EditResult = {
  readonly ok: true;
  readonly kind: "edit";
  readonly replacements: 1;
};

export type BashResult = {
  readonly ok: true;
  readonly kind: "bash";
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type InvalidPathError = {
  readonly kind: "invalid-path";
  readonly path: string;
  readonly reason: WorkspacePathError;
};

type WorkspaceError = {
  readonly kind: "workspace-error";
  readonly operation: PrimitiveKind;
  readonly detail: string;
};

type ReadError =
  | InvalidPathError
  | WorkspaceError
  | { readonly kind: "file-not-found"; readonly path: string }
  | { readonly kind: "binary-file"; readonly path: string };

type WriteError = InvalidPathError | WorkspaceError;

type EditError =
  | InvalidPathError
  | WorkspaceError
  | EditMatchError
  | { readonly kind: "file-not-found"; readonly path: string }
  | { readonly kind: "binary-file"; readonly path: string };

type BashError =
  | WorkspaceError
  | {
      readonly kind: "timeout";
      readonly command: string;
      readonly timeoutMs: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly kind: "invalid-timeout"; readonly timeoutMs: number };

type Failure<K extends PrimitiveKind, E> = {
  readonly ok: false;
  readonly kind: K;
  readonly error: E;
};

type ReadFailure = Failure<"read", ReadError>;
type WriteFailure = Failure<"write", WriteError>;
type EditFailure = Failure<"edit", EditError>;
type BashFailure = Failure<"bash", BashError>;

export type PrimitiveFailure = ReadFailure | WriteFailure | EditFailure | BashFailure;
export type PrimitiveResult = ReadResult | WriteResult | EditResult | BashResult | PrimitiveFailure;

export type PrimitiveOptions = {
  readonly bashTimeoutMs?: number;
};

export const DEFAULT_BASH_TIMEOUT_MS = 30_000;

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function workspaceError(operation: PrimitiveKind, error: unknown): WorkspaceError {
  return { kind: "workspace-error", operation, detail: errorDetail(error) };
}

function invalidPath(path: string, reason: WorkspacePathError): InvalidPathError {
  return { kind: "invalid-path", path, reason };
}

async function readPrimitive(
  call: ReadCall,
  workspace: Workspace,
): Promise<ReadResult | ReadFailure> {
  const validation = validateWorkspacePath(call.path);
  if (!validation.ok) {
    return { ok: false, kind: "read", error: invalidPath(call.path, validation.reason) };
  }

  let content;
  try {
    content = await workspace.readFile(validation.path);
  } catch (error: unknown) {
    return { ok: false, kind: "read", error: workspaceError("read", error) };
  }
  if (content === undefined) {
    return {
      ok: false,
      kind: "read",
      error: { kind: "file-not-found", path: call.path },
    };
  }
  if (typeof content !== "string") {
    return { ok: false, kind: "read", error: { kind: "binary-file", path: call.path } };
  }
  return { ok: true, kind: "read", content };
}

async function writePrimitive(
  call: WriteCall,
  workspace: Workspace,
): Promise<WriteResult | WriteFailure> {
  const validation = validateWorkspacePath(call.path);
  if (!validation.ok) {
    return { ok: false, kind: "write", error: invalidPath(call.path, validation.reason) };
  }

  try {
    await workspace.writeFile(validation.path, call.content);
  } catch (error: unknown) {
    return { ok: false, kind: "write", error: workspaceError("write", error) };
  }
  return {
    ok: true,
    kind: "write",
    bytesWritten: new TextEncoder().encode(call.content).byteLength,
  };
}

async function editPrimitive(
  call: EditCall,
  workspace: Workspace,
): Promise<EditResult | EditFailure> {
  const validation = validateWorkspacePath(call.path);
  if (!validation.ok) {
    return { ok: false, kind: "edit", error: invalidPath(call.path, validation.reason) };
  }
  let current;
  try {
    current = await workspace.readFile(validation.path);
  } catch (error: unknown) {
    return { ok: false, kind: "edit", error: workspaceError("edit", error) };
  }
  if (current === undefined) {
    return {
      ok: false,
      kind: "edit",
      error: { kind: "file-not-found", path: call.path },
    };
  }
  if (typeof current !== "string") {
    return { ok: false, kind: "edit", error: { kind: "binary-file", path: call.path } };
  }

  const decision = prepareEdit(call.path, current, call.oldText, call.newText);
  if (!decision.ok) {
    return { ok: false, kind: "edit", error: decision.error };
  }

  try {
    await workspace.writeFile(validation.path, decision.content);
  } catch (error: unknown) {
    return { ok: false, kind: "edit", error: workspaceError("edit", error) };
  }
  return { ok: true, kind: "edit", replacements: 1 };
}

async function bashPrimitive(
  call: BashCall,
  workspace: Workspace,
  options: PrimitiveOptions | undefined,
): Promise<BashResult | BashFailure> {
  const timeoutMs = options?.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return { ok: false, kind: "bash", error: { kind: "invalid-timeout", timeoutMs } };
  }

  let execution: WorkspaceCommandResult;
  try {
    execution = await workspace.execute(call.command, { timeoutMs });
  } catch (error: unknown) {
    return { ok: false, kind: "bash", error: workspaceError("bash", error) };
  }
  switch (execution.status) {
    case "completed":
      return {
        ok: true,
        kind: "bash",
        exitCode: execution.exitCode,
        stdout: execution.stdout,
        stderr: execution.stderr,
      };
    case "timed-out":
      return {
        ok: false,
        kind: "bash",
        error: {
          kind: "timeout",
          command: call.command,
          timeoutMs,
          stdout: execution.stdout,
          stderr: execution.stderr,
        },
      };
    default:
      return assertNever(execution, "workspace command result");
  }
}

/** Execute one of the four fixed primitives against a workspace. */
export function executePrimitive(
  call: PrimitiveCall,
  workspace: Workspace,
  options?: PrimitiveOptions,
): Promise<PrimitiveResult> {
  switch (call.kind) {
    case "read":
      return readPrimitive(call, workspace);
    case "write":
      return writePrimitive(call, workspace);
    case "edit":
      return editPrimitive(call, workspace);
    case "bash":
      return bashPrimitive(call, workspace, options);
    default:
      return assertNever(call, "primitive");
  }
}

export const runPrimitive = executePrimitive;
