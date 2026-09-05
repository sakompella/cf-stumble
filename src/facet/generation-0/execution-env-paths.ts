import { FileError } from "@cf-stumble/pi";
import type { Result } from "@cf-stumble/pi";
/**
 * `WORKSPACE_ROOT` is this adapter's root in two namespaces at once: its own absolute-path
 * namespace (what Pi sees) and the project RPC target's addressed-path namespace (where the same
 * location is simply "/"). Every path this adapter accepts or returns lives inside it.
 *
 * It is imported rather than declared here. `workspace-layout.ts` owns the root and the project
 * RPC target reads the same constant, so the escape check below and that target's address
 * translation cannot drift into two different opinions of what is inside the workspace.
 */
import { WORKSPACE_ROOT } from "../../workspace-layout.js";

/** `@cf-stumble/pi` exports the `FileError` class but not its `FileErrorCode` union; derive it. */
type FileErrorCode = FileError["code"];

/**
 * Lexically resolves a Pi-supplied path — relative to `cwd`, or already absolute — against the
 * fixed workspace root, the same way `path.posix.resolve` would: it never touches the filesystem
 * and never follows a symlink. `.` segments are dropped and `..` pops the previous segment, exactly
 * as POSIX does at the filesystem root, so a `..` that would climb above the root is caught the
 * moment the walk finishes rather than left to look like a valid path outside the root.
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

/** Converts one of this adapter's own absolute paths (rooted at the workspace root) to the project RPC
 * target's addressed-path form (rooted at `/`). `resolveAbsolute`'s output is always a valid input. */
export function toAddressedPath(absolute: string): string {
  return absolute === WORKSPACE_ROOT ? "/" : absolute.slice(WORKSPACE_ROOT.length);
}

/** The inverse of {@link toAddressedPath}: an addressed path from the project RPC target back to
 * one of this adapter's own absolute paths. */
export function fromAddressedPath(addressed: string): string {
  return addressed === "/" ? WORKSPACE_ROOT : `${WORKSPACE_ROOT}${addressed}`;
}

/**
 * Every code the project RPC target's six methods are documented to raise, translated to Pi's own
 * `FileErrorCode` vocabulary. Pi has no equivalent of "already exists", "path escapes the root", a
 * malformed request, a too-large file, or a symlink loop, so each of those becomes `invalid`: the
 * addressed operation was rejected, not silently reinterpreted. An unavailable backend becomes
 * `unknown`, and any code this map has never seen — from a target this adapter does not yet know
 * about — becomes `unknown` too, rather than being reported as if it mapped to nothing at all.
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

/** Maps one project RPC target failure code to a local `FileError`, carrying Pi's own addressed path. */
export function mapProjectError(code: string, path?: string): FileError {
  const mapped = PROJECT_ERROR_TO_FILE_ERROR_CODE.get(code) ?? "unknown";
  return new FileError(mapped, `the project target reported "${code}"`, path);
}
