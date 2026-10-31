import { logRedactedCause, redactedExcerpt } from "../../diagnostics.js";
import { hasErrnoCode } from "../errno-code.js";
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

export function mapProviderError(cause: unknown): ProjectErrorCode {
  const code = hasErrnoCode(cause) ? cause.code : undefined;
  const mapped = code === undefined ? undefined : ERROR_CODE_MAP.get(code);

  if (mapped !== undefined) return mapped;
  logRedactedCause(
    `unmapped project provider error (${redactedExcerpt(code ?? "no code")})`,
    cause,
  );

  return "backend-unavailable";
}
