import type { ProjectErrorCode } from "./protocol.js";

/** The metadata this target needs about one filesystem node. Mirrors `VirtualStatsLike`. */
export interface ProjectStat {
  size: number;
  mtimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface ProjectDirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/**
 * The narrow slice of `@cloudflare/computer`'s `SQLiteWorkspaceProvider` this target needs.
 * `appendFile`/`appendFileSync` and `realpath`/`realpathSync` are deliberately absent: the first
 * throws `ENOSYS` on the real provider, and the second only normalizes the lexical path rather
 * than resolving symlinks, so neither is usable here. Byte-level writes go through
 * `openSync`/`writeSync`/`closeSync` inside a caller-supplied transaction instead.
 */
export interface ProjectFilesystemProvider {
  lstatSync(path: string): ProjectStat;
  readlinkSync(path: string): string;
  mkdirSync(path: string): void;
  readdirSync(path: string, options: { withFileTypes: true }): ProjectDirent[];
  openSync(path: string, flags: "w" | "a" | "wx"): number;
  writeSync(fd: number, buffer: Uint8Array): number;
  closeSync(fd: number): void;
  readFileSync(path: string): Uint8Array;
}

/** Runs one write inside the workspace's synchronous SQLite transaction. Mirrors `Database`. */
export interface ProjectTransactions {
  transactionSync<T>(closure: () => T): T;
}

const ERROR_CODE_MAP = new Map<string, ProjectErrorCode>([
  ["ENOENT", "not-found"],
  ["ENOTDIR", "not-directory"],
  ["EISDIR", "is-directory"],
  ["EACCES", "permission-denied"],
  ["EPERM", "permission-denied"],
  ["EROFS", "permission-denied"],
  ["EEXIST", "already-exists"],
  ["ELOOP", "symlink-loop"],
]);

/** Narrows an unknown thrown value to the errno-style code the real provider attaches. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the provider threw this value; its documented shape is untrusted here.
function errnoCode(error: unknown): string | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: narrowing an untrusted thrown value to check for a `code` field.
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  const { code } = error;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: the narrowed `code` field is still untrusted until its type is checked.
  return typeof code === "string" ? code : undefined;
}

/**
 * Maps a provider error to one of this target's typed failure codes. Every code the provider is
 * documented to raise for these operations (ENOENT, ENOTDIR, EISDIR, EACCES/EPERM/EROFS, EEXIST,
 * ELOOP) gets a specific mapping; anything else — including a thrown non-error value — becomes
 * `backend-unavailable` so a caller never sees an unmapped error shape.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the provider threw this value; its documented shape is untrusted here.
export function mapProviderError(error: unknown): ProjectErrorCode {
  const code = errnoCode(error);
  const mapped = code === undefined ? undefined : ERROR_CODE_MAP.get(code);
  if (mapped !== undefined) return mapped;
  // `backend-unavailable` is the one code that says nothing about what happened, and a deployed
  // write reached the agent as exactly that with the cause thrown away. What the provider actually
  // threw exists nowhere else.
  console.error("unmapped project provider error", code ?? "no code", String(error));
  return "backend-unavailable";
}
