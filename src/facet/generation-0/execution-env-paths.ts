import { FileError } from "@cf-stumble/pi";
import type { Result } from "@cf-stumble/pi";
/** The workspace root is Pi's absolute root and the project RPC target's "/". */
import { WORKSPACE_ROOT } from "../../workspace-layout.js";

/** `@cf-stumble/pi` exports the `FileError` class but not its `FileErrorCode` union; derive it. */
type FileErrorCode = FileError["code"];

/**
 * Lexical only, like `path.posix.resolve`: never touches the filesystem or follows symlinks. A `..`
 * above the root is caught after the walk.
 */
export function resolveAbsolute(cwd: string, path: string): Result<string, FileError> {
  const base = path.startsWith("/") ? path : `${cwd}/${path}`;
  const segments: string[] = [];

  for (const segment of base.split("/")) {
    if (segment === "" || segment === ".") continue;

    if (segment === "..") {
      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  const absolute = segments.length === 0 ? "/" : `/${segments.join("/")}`;

  if (absolute !== WORKSPACE_ROOT && !absolute.startsWith(`${WORKSPACE_ROOT}/`)) {
    return {
      ok: false,
      error: new FileError("invalid", `path escapes ${WORKSPACE_ROOT}: ${path}`, path),
    };
  }

  return { ok: true, value: absolute };
}

export function toAddressedPath(absolute: string): string {
  return absolute === WORKSPACE_ROOT ? "/" : absolute.slice(WORKSPACE_ROOT.length);
}

export function fromAddressedPath(addressed: string): string {
  return addressed === "/" ? WORKSPACE_ROOT : `${WORKSPACE_ROOT}${addressed}`;
}

/**
 * Pi has no equivalent of already exists, escape, malformed request, too large, or symlink loop, so
 * those become `invalid`. Unavailable and unseen codes become `unknown`.
 */
const PROJECT_ERROR_TO_FILE_ERROR_CODE = new Map<string, FileErrorCode>([
  ["not-found", "not_found"],
  ["not-directory", "not_directory"],
  ["is-directory", "is_directory"],
  ["permission-denied", "permission_denied"],
  ["already-exists", "invalid"],
  ["invalid-request", "invalid"],
  ["path-outside-root", "invalid"],
  ["content-too-large", "invalid"],
  ["symlink-loop", "invalid"],
  ["backend-unavailable", "unknown"],
]);

export function mapProjectError(code: string, path?: string): FileError {
  const mapped = PROJECT_ERROR_TO_FILE_ERROR_CODE.get(code) ?? "unknown";

  return new FileError(mapped, `the project target reported "${code}"`, path);
}
