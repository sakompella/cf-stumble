export const MAX_FILE_BYTES = 1_000_000;

export const MAX_EXEC_TIMEOUT_MS = 10 * 60 * 1_000;

export const MAX_EXEC_COMMAND_BYTES = 65_536;

export const MAX_CONCURRENT_EXECS = 8;

export const MAX_EXEC_FRAME_BYTES = 65_536;

export type ProjectErrorCode =
  | "not-found"
  | "not-directory"
  | "is-directory"
  | "permission-denied"
  | "already-exists"
  | "invalid-request"
  | "path-outside-root"
  | "content-too-large"
  | "symlink-loop"
  | "backend-unavailable"
  | "too-many-operations"
  | "turn-ended"
  | "container-restarted";

export type ProjectFailure = { ok: false; error: { code: ProjectErrorCode; path?: string } };

export type ProjectFailureDetail = ProjectFailure["error"];

export type ProjectResult<T> = { ok: true; value: T } | ProjectFailure;

export type ProjectFileKind = "file" | "directory" | "symlink";

export type ProjectFileInfo = {
  name: string;
  path: string;
  kind: ProjectFileKind;
  size: number;
  mtimeMs: number;
};

export type ProjectLstatInfo = ProjectFileInfo & { canonicalPath: ProjectResult<string> };

export type WriteMode = "overwrite" | "append" | "create-exclusive";

export type ExecEvent =
  | { kind: "stdout"; seq: number; data: string }
  | { kind: "stderr"; seq: number; data: string }
  | {
      kind: "terminal";
      seq: number;
      outcome: "exited";
      exitCode: number;
      fullOutputPaths?: readonly string[] | undefined;
    }
  | { kind: "terminal"; seq: number; outcome: "killed" | "timed-out" }
  | {
      kind: "terminal";
      seq: number;
      outcome: "failed";
      error: { code: "backend-unavailable" | "container-restarted" };
    };

export type ExecBackendChoice = "isolate" | "container";

export type StartExecWire = Readonly<{
  command: string;
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
  backend?: ExecBackendChoice | undefined;
}>;

export type WriteFileWire = Readonly<{ path: string; bytes: Uint8Array; mode: WriteMode }>;

export interface ProjectRpcTargetContract {
  lstat(path: string): Promise<ProjectResult<ProjectLstatInfo>>;
  readFile(path: string): Promise<ProjectResult<Uint8Array>>;
  writeFile(path: string, bytes: Uint8Array, mode: WriteMode): Promise<ProjectResult<null>>;
  startExec(
    input: StartExecWire,
  ): Promise<ProjectResult<{ operationId: string; events: ReadableStream<Uint8Array> }>>;
  kill(operationId: string): Promise<ProjectResult<null>>;
  endTurn(): Promise<ProjectResult<{ killed: number }>>;
}

export function ok<T>(value: T): ProjectResult<T> {
  return { ok: true, value };
}

export function failureDetail(code: ProjectErrorCode, path?: string): ProjectFailureDetail {
  return path === undefined ? { code } : { code, path };
}

export function fail<T>(code: ProjectErrorCode, path?: string): ProjectResult<T> {
  return { ok: false, error: failureDetail(code, path) };
}
