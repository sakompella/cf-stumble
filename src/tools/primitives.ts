import { Result } from "better-result";
import { assertNever } from "../git/types.js";
import { prepareEdit } from "./edit.js";
import {
  BinaryFileError,
  CommandTimeoutError,
  InvalidCommandTimeoutError,
  WorkspaceFileNotFoundError,
  WorkspaceOperationError,
  type BashPrimitiveError,
  type EditPrimitiveError,
  type PrimitiveError,
  type ReadPrimitiveError,
  type WritePrimitiveError,
} from "./errors.js";
import {
  parseWorkspacePath,
  type Workspace,
  type WorkspaceFileContent,
  type WorkspacePath,
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
  readonly kind: "read";
  readonly content: string;
};

export type WriteResult = {
  readonly kind: "write";
  readonly bytesWritten: number;
};

export type EditResult = {
  readonly kind: "edit";
  readonly replacements: 1;
};

export type BashResult = {
  readonly kind: "bash";
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** What a primitive produces when it succeeds. Failure is carried by the `Result`, not by a flag. */
export type PrimitiveSuccess = ReadResult | WriteResult | EditResult | BashResult;

export type PrimitiveResult = Result<PrimitiveSuccess, PrimitiveError>;

export type PrimitiveOptions = {
  readonly bashTimeoutMs?: number;
};

export const DEFAULT_BASH_TIMEOUT_MS = 30_000;

/** Wrap one `Workspace` call so a thrown infrastructure error becomes a typed failure. */
function workspaceCall<T>(
  operation: PrimitiveKind,
  run: () => Promise<T>,
): Promise<Result<T, WorkspaceOperationError>> {
  return Result.tryPromise({
    try: run,
    catch: (cause: unknown) => new WorkspaceOperationError({ operation, cause }),
  });
}

/** Read text a primitive is about to operate on, rejecting an absent or binary file. */
async function readTextFile(
  operation: PrimitiveKind,
  path: WorkspacePath,
  reportedPath: string,
  workspace: Workspace,
): Promise<Result<string, ReadPrimitiveError>> {
  const content = await workspaceCall(operation, () => workspace.readFile(path));
  if (Result.isError(content)) {
    return content;
  }
  if (content.value === undefined) {
    return Result.err(new WorkspaceFileNotFoundError({ path: reportedPath }));
  }
  if (!isTextContent(content.value)) {
    return Result.err(new BinaryFileError({ path: reportedPath }));
  }
  return Result.ok(content.value);
}

async function readPrimitive(
  call: ReadCall,
  workspace: Workspace,
): Promise<Result<ReadResult, ReadPrimitiveError>> {
  const path = parseWorkspacePath(call.path);
  if (Result.isError(path)) {
    return path;
  }
  const content = await readTextFile("read", path.value, call.path, workspace);
  if (Result.isError(content)) {
    return content;
  }
  return Result.ok({ kind: "read", content: content.value });
}

async function writePrimitive(
  call: WriteCall,
  workspace: Workspace,
): Promise<Result<WriteResult, WritePrimitiveError>> {
  const path = parseWorkspacePath(call.path);
  if (Result.isError(path)) {
    return path;
  }
  const written = await workspaceCall("write", () => workspace.writeFile(path.value, call.content));
  if (Result.isError(written)) {
    return written;
  }
  return Result.ok({
    kind: "write",
    bytesWritten: new TextEncoder().encode(call.content).byteLength,
  });
}

async function editPrimitive(
  call: EditCall,
  workspace: Workspace,
): Promise<Result<EditResult, EditPrimitiveError>> {
  const path = parseWorkspacePath(call.path);
  if (Result.isError(path)) {
    return path;
  }
  const current = await readTextFile("edit", path.value, call.path, workspace);
  if (Result.isError(current)) {
    return current;
  }

  const edited = prepareEdit(call.path, current.value, call.oldText, call.newText);
  if (Result.isError(edited)) {
    return edited;
  }

  const written = await workspaceCall("edit", () => workspace.writeFile(path.value, edited.value));
  if (Result.isError(written)) {
    return written;
  }
  return Result.ok({ kind: "edit", replacements: 1 });
}

async function bashPrimitive(
  call: BashCall,
  workspace: Workspace,
  options: PrimitiveOptions | undefined,
): Promise<Result<BashResult, BashPrimitiveError>> {
  const timeoutMs = options?.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return Result.err(new InvalidCommandTimeoutError({ timeoutMs }));
  }

  const executed = await workspaceCall("bash", () =>
    workspace.execute(call.command, { timeoutMs }),
  );
  if (Result.isError(executed)) {
    return executed;
  }

  // Bound to a local so the switch below narrows the union.
  const execution = executed.value;
  switch (execution.status) {
    case "completed":
      return Result.ok({
        kind: "bash",
        exitCode: execution.exitCode,
        stdout: execution.stdout,
        stderr: execution.stderr,
      });
    case "timed-out":
      return Result.err(
        new CommandTimeoutError({
          command: call.command,
          timeoutMs,
          stdout: execution.stdout,
          stderr: execution.stderr,
        }),
      );
    default:
      return assertNever(execution, "workspace command result");
  }
}

function isTextContent(content: WorkspaceFileContent): content is string {
  return typeof content === "string";
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
