declare const workspacePathBrand: unique symbol;

/** A validated relative path inside a workspace. Construct with {@link parseWorkspacePath}. */
export type WorkspacePath = string & { readonly [workspacePathBrand]: true };

export type WorkspacePathError =
  | "empty"
  | "absolute"
  | "nul-byte"
  | "backslash"
  | "path-traversal"
  | "dot-segment"
  | "empty-segment";

export type WorkspacePathValidation =
  | { readonly ok: true; readonly path: WorkspacePath }
  | { readonly ok: false; readonly reason: WorkspacePathError };

const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:/u;

function pathError(path: string): WorkspacePathError | undefined {
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
  return pathError(value) === undefined;
}

export function validateWorkspacePath(path: string): WorkspacePathValidation {
  const reason = pathError(path);
  if (reason !== undefined) {
    return { ok: false, reason };
  }
  if (!isWorkspacePath(path)) {
    throw new Error("workspace path validator disagreed with its predicate");
  }
  return { ok: true, path };
}

/** Parse a path supplied by trusted setup code. Primitive calls use the non-throwing validator. */
export function parseWorkspacePath(path: string): WorkspacePath {
  const validation = validateWorkspacePath(path);
  if (!validation.ok) {
    throw new TypeError(`invalid workspace path (${validation.reason}): ${JSON.stringify(path)}`);
  }
  return validation.path;
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
