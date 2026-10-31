import { logRedactedCause, redactedExcerpt } from "../../diagnostics.js";
import type { ProjectErrorCode } from "./protocol.js";

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

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the provider threw this value; its documented shape is untrusted here.
function errnoCode(error: unknown): string | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: narrowing an untrusted thrown value to check for a `code` field.
  if (error === null || typeof error !== "object" || !("code" in error)) return undefined;
  const { code } = error;

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: the narrowed `code` field is still untrusted until its type is checked.
  return typeof code === "string" ? code : undefined;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the provider threw this value; its documented shape is untrusted here.
export function mapProviderError(error: unknown): ProjectErrorCode {
  const code = errnoCode(error);
  const mapped = code === undefined ? undefined : ERROR_CODE_MAP.get(code);

  if (mapped !== undefined) return mapped;
  logRedactedCause(
    `unmapped project provider error (${redactedExcerpt(code ?? "no code")})`,
    error,
  );

  return "backend-unavailable";
}
