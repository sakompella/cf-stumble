import { Result, panic } from "better-result";
import { InvalidWorkspacePathError, type WorkspacePathRejection } from "./errors.js";

declare const workspacePathBrand: unique symbol;

/** A validated relative path inside a workspace. Construct with {@link parseWorkspacePath}. */
export type WorkspacePath = string & { readonly [workspacePathBrand]: true };

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:/u;

function pathRejection(path: string): WorkspacePathRejection | undefined {
  if (path.length === 0) {
    return "empty";
  }
  if (path.startsWith("/") || WINDOWS_ABSOLUTE_PATH.test(path)) {
    return "absolute";
  }
  if (path.includes("\0")) {
    return "nul-byte";
  }
  if (path.includes("\\")) {
    return "backslash";
  }

  for (const segment of path.split("/")) {
    if (segment === "..") {
      return "path-traversal";
    }
    if (segment === ".") {
      return "dot-segment";
    }
    if (segment.length === 0) {
      return "empty-segment";
    }
  }
  return undefined;
}

export function isWorkspacePath(value: string): value is WorkspacePath {
  return pathRejection(value) === undefined;
}

/**
 * Narrow an untrusted string into a {@link WorkspacePath}.
 *
 * The brand is applied by {@link isWorkspacePath}, a type predicate, so no assertion is involved
 * (ADR-0015). The predicate and the rejection reason come from the same classifier, so the two
 * cannot disagree about whether a path is valid — but the compiler cannot see that, which is why
 * the impossible branch panics rather than inventing a reason to report.
 */
export function parseWorkspacePath(path: string): Result<WorkspacePath, InvalidWorkspacePathError> {
  if (isWorkspacePath(path)) {
    return Result.ok(path);
  }
  const rejection = pathRejection(path);
  if (rejection === undefined) {
    panic(
      `workspace path classifier disagreed with its predicate: isWorkspacePath rejected ${JSON.stringify(path)} but pathRejection found no reason`,
    );
  }
  return Result.err(new InvalidWorkspacePathError({ path, rejection }));
}

export type WorkspaceFileContent = string | Uint8Array;

export type WorkspaceCommandResult =
  | {
      readonly status: "completed";
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      readonly status: "timed-out";
      readonly stdout: string;
      readonly stderr: string;
    };

export type ExecuteCommandOptions = {
  /** The workspace must stop the command by this deadline and report a timed-out result. */
  readonly timeoutMs: number;
};

/** The only filesystem and command capabilities the primitives are allowed to use. */
export interface Workspace {
  readFile(path: WorkspacePath): Promise<WorkspaceFileContent | undefined>;
  /** Implementations create missing parent directories and overwrite an existing file. */
  writeFile(path: WorkspacePath, content: string): Promise<void>;
  listFiles(): Promise<readonly WorkspacePath[]>;
  exists(path: WorkspacePath): Promise<boolean>;
  execute(command: string, options: ExecuteCommandOptions): Promise<WorkspaceCommandResult>;
}
