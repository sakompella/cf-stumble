/**
 * The public contract for the narrow project-only RPC target. Every method accepts `unknown` at
 * its boundary and returns a plain, RPC-serializable `ProjectResult` rather than throwing, so a
 * caller across a Workers RPC hop never has to catch a rejected capability call to learn why an
 * operation failed.
 */

/** Largest file this target will read or write in one call. */
export const MAX_FILE_BYTES = 1_000_000;

/** Largest timeout a caller may request for `startExec`; also the default when omitted. */
export const MAX_EXEC_TIMEOUT_MS = 10 * 60 * 1_000;

/** Largest command accepted by `startExec`, measured after UTF-8 encoding. */
export const MAX_EXEC_COMMAND_BYTES = 65_536;

/** Number of commands that may run concurrently in one project workspace. */
export const MAX_CONCURRENT_EXECS = 8;

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

/**
 * The contract `ProjectRpcTarget` (in `target.ts`) implements. Named separately from the class so
 * both can be imported without a collision.
 */
// This is the RPC boundary itself: every argument arrives untrusted and each implementation
// parses it before use, so `unknown` here is intentional rather than a missing parse step.
export interface ProjectRpcTargetContract {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the RPC boundary; the implementation parses `path`.
  lstat(path: unknown): Promise<ProjectResult<ProjectLstatInfo>>;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the RPC boundary; the implementation parses `path`.
  readFile(path: unknown): Promise<ProjectResult<Uint8Array>>;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the RPC boundary; the implementation parses every argument.
  writeFile(path: unknown, bytes: unknown, mode: unknown): Promise<ProjectResult<null>>;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the RPC boundary; the implementation parses `path`.
  listFiles(path: unknown): Promise<ProjectResult<readonly ProjectFileInfo[]>>;
  startExec(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the RPC boundary; the implementation parses `input`.
    input: unknown,
  ): Promise<ProjectResult<{ operationId: string; events: ReadableStream<ExecEvent> }>>;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the RPC boundary; the implementation parses `operationId`.
  kill(operationId: unknown): Promise<ProjectResult<null>>;
}

export function ok<T>(value: T): ProjectResult<T> {
  return { ok: true, value };
}

export function fail<T>(code: ProjectErrorCode, path?: string): ProjectResult<T> {
  return path === undefined ? { ok: false, error: { code } } : { ok: false, error: { code, path } };
}
