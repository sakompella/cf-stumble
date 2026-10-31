import { FileError, type FileErrorCode, type Result } from "@earendil-works/pi-durable/env";
import { WORKSPACE_ROOT } from "../../workspace-layout.js";
import type {
  ProjectErrorCode,
  ProjectResult,
  ProjectRpcTargetContract,
} from "../../workspace/project/protocol.js";

export interface WorkspacePath {
  readonly absolute: string;
  readonly addressed: string;
}

export interface ComputerWorkspace {
  readonly cwd: string;
  readonly target: ProjectRpcTargetContract;
}

function normalizePosix(path: string): string {
  const absolute = path.startsWith("/");
  const segments: string[] = [];

  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;

    if (segment === ".." && segments.length > 0 && segments.at(-1) !== "..") segments.pop();
    else if (segment !== ".." || !absolute) segments.push(segment);
  }

  if (absolute) return `/${segments.join("/")}`;

  return segments.length === 0 ? "." : segments.join("/");
}

export function joinPath(parts: readonly string[]): Promise<Result<string, FileError>> {
  const path = normalizePosix(parts.filter((part) => part !== "").join("/"));

  return Promise.resolve({ ok: true, value: path });
}

export function basename(absolute: string): string {
  return absolute.slice(absolute.lastIndexOf("/") + 1);
}

export function resolveInWorkspace(cwd: string, path: string): Result<WorkspacePath, FileError> {
  const absolute = normalizePosix(path.startsWith("/") ? path : `${cwd}/${path}`);

  if (absolute !== WORKSPACE_ROOT && !absolute.startsWith(`${WORKSPACE_ROOT}/`)) {
    return {
      ok: false,
      error: new FileError("invalid", `path is outside ${WORKSPACE_ROOT}`, path),
    };
  }

  return { ok: true, value: { absolute, addressed: toAddressed(absolute) } };
}

function toAddressed(absolute: string): string {
  return absolute === WORKSPACE_ROOT ? "/" : absolute.slice(WORKSPACE_ROOT.length);
}

export function fromAddressed(addressed: string): WorkspacePath {
  return {
    absolute: addressed === "/" ? WORKSPACE_ROOT : `${WORKSPACE_ROOT}${addressed}`,
    addressed,
  };
}

const FILE_ERROR_CODES: Readonly<Record<ProjectErrorCode, FileErrorCode>> = {
  "not-found": "not_found",
  "not-directory": "not_directory",
  "is-directory": "is_directory",
  "permission-denied": "permission_denied",
  "already-exists": "invalid",
  "invalid-request": "invalid",
  "path-outside-root": "invalid",
  "content-too-large": "invalid",
  "symlink-loop": "invalid",
  "backend-unavailable": "unknown",
  "too-many-operations": "unknown",
  "turn-ended": "unknown",
  "container-restarted": "unknown",
};

function fileErrorOf(code: ProjectErrorCode, path?: string): FileError {
  return new FileError(FILE_ERROR_CODES[code], `the Computer capability reported "${code}"`, path);
}

export function aborted(path?: string): Result<never, FileError> {
  return { ok: false, error: new FileError("aborted", "aborted", path) };
}

export function invalid(message: string, path?: string): Result<never, FileError> {
  return { ok: false, error: new FileError("invalid", message, path) };
}

export function fromProject<T>(result: ProjectResult<T>, path: string): Result<T, FileError> {
  return result.ok ? result : { ok: false, error: fileErrorOf(result.error.code, path) };
}

export async function capabilityCall<T>(
  path: string,
  call: () => Promise<ProjectResult<T>>,
): Promise<Result<T, FileError>> {
  try {
    return fromProject(await call(), path);
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;

    return {
      ok: false,
      error: new FileError("unknown", "the capability call rejected", path, cause),
    };
  }
}
