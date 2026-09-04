// oxlint-disable anti-slop/no-unknown-parameters

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
  | "too-many-operations";

export type ProjectFailure = { ok: false; error: { code: ProjectErrorCode; path?: string } };
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
  | { kind: "terminal"; seq: number; outcome: "exited"; exitCode: number }
  | { kind: "terminal"; seq: number; outcome: "killed" | "timed-out" }
  | { kind: "terminal"; seq: number; outcome: "failed"; error: { code: "backend-unavailable" } };

export type StartExecInput = { command: string; cwd?: string; timeoutMs?: number };

export interface ProjectRpcTargetContract {
  lstat(path: unknown): Promise<ProjectResult<ProjectLstatInfo>>;
  readFile(path: unknown): Promise<ProjectResult<Uint8Array>>;
  writeFile(path: unknown, bytes: unknown, mode: unknown): Promise<ProjectResult<null>>;
  listFiles(path: unknown): Promise<ProjectResult<readonly ProjectFileInfo[]>>;
  startExec(
    input: unknown,
  ): Promise<ProjectResult<{ operationId: string; events: ReadableStream<Uint8Array> }>>;
  kill(operationId: unknown): Promise<ProjectResult<null>>;
}

export function ok<T>(value: T): ProjectResult<T> {
  return { ok: true, value };
}

export function fail<T>(code: ProjectErrorCode, path?: string): ProjectResult<T> {
  return path === undefined ? { ok: false, error: { code } } : { ok: false, error: { code, path } };
}
