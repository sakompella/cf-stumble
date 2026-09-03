import { asUntrusted, field, fieldsAreExactly, type UntrustedObject } from "./untrusted.js";

export type WorkspaceConfiguration = Readonly<{
  root: string;
  commands: Readonly<Record<string, string>>;
}>;

export type WorkspaceRequest =
  | Readonly<{ kind: "read-file"; path: string }>
  | Readonly<{ kind: "write-file"; path: string; content: string }>
  | Readonly<{ kind: "list-files"; path: string }>
  | Readonly<{ kind: "run-command"; command: string }>
  | Readonly<{ kind: "git-diff" }>;

export type WorkspacePlan =
  | Readonly<{ kind: "read-file"; path: string }>
  | Readonly<{ kind: "write-file"; path: string; content: string }>
  | Readonly<{ kind: "list-files"; path: string }>
  | Readonly<{ kind: "run-command"; source: string; cwd: string }>
  | Readonly<{ kind: "git-diff"; cwd: string }>;

export type WorkspaceFailure = Readonly<{
  ok: false;
  error: Readonly<{
    code: "invalid-request" | "path-outside-root" | "unknown-command" | "workspace-unavailable";
  }>;
}>;

export type WorkspaceResult =
  | Readonly<{ ok: true; result: Readonly<{ kind: "file"; content: string }> }>
  | Readonly<{ ok: true; result: Readonly<{ kind: "written" }> }>
  | Readonly<{ ok: true; result: Readonly<{ kind: "files"; entries: readonly string[] }> }>
  | Readonly<{
      ok: true;
      result: Readonly<{
        kind: "command" | "git-diff";
        stdout: string;
        stderr: string;
        exitCode: number;
      }>;
    }>
  | WorkspaceFailure;

function invalidRequest(): WorkspaceFailure {
  return { ok: false, error: { code: "invalid-request" } };
}

function parsePathRequest(
  value: UntrustedObject,
  kind: "read-file" | "list-files",
): WorkspaceRequest | WorkspaceFailure {
  if (!fieldsAreExactly(value, ["kind", "path"])) return invalidRequest();
  const path = field(value, "path");
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: request path comes from RPC.
  return typeof path === "string" ? { kind, path } : invalidRequest();
}

/** Parse the small RPC surface before any workspace operation runs. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the Workspace Host RPC boundary.
export function parseWorkspaceRequest(value: unknown): WorkspaceRequest | WorkspaceFailure {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: the RPC payload is untrusted.
  if (value === null || typeof value !== "object") return invalidRequest();
  const request = asUntrusted(value);
  const kind = field(request, "kind");
  switch (kind) {
    case "read-file":
    case "list-files":
      return parsePathRequest(request, kind);
    case "write-file": {
      if (!fieldsAreExactly(request, ["kind", "path", "content"])) return invalidRequest();
      const path = field(request, "path");
      const content = field(request, "content");
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: RPC fields are untrusted.
      if (typeof path !== "string" || typeof content !== "string") return invalidRequest();
      return { kind, path, content };
    }
    case "run-command": {
      if (!fieldsAreExactly(request, ["kind", "command"])) return invalidRequest();
      const command = field(request, "command");
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary: RPC command name is untrusted.
      return typeof command === "string" ? { kind, command } : invalidRequest();
    }
    case "git-diff":
      return fieldsAreExactly(request, ["kind"]) ? { kind } : invalidRequest();
    default:
      return invalidRequest();
  }
}

type ResolvedWorkspacePath = Readonly<{ path: string }>;

function resolvePath(root: string, path: string): ResolvedWorkspacePath | WorkspaceFailure {
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\u0000") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return { ok: false, error: { code: "path-outside-root" } };
  }
  return { path: path === "" ? root : `${root}/${path}` };
}

/** Decide a complete workspace operation from plain configuration and parsed input. */
export function planWorkspaceRequest(
  configuration: WorkspaceConfiguration,
  request: WorkspaceRequest,
): WorkspacePlan | WorkspaceFailure {
  switch (request.kind) {
    case "read-file": {
      const path = resolvePath(configuration.root, request.path);
      if ("ok" in path) return path;
      return { kind: request.kind, path: path.path };
    }
    case "write-file": {
      const path = resolvePath(configuration.root, request.path);
      if ("ok" in path) return path;
      return { kind: request.kind, path: path.path, content: request.content };
    }
    case "list-files": {
      const path = resolvePath(configuration.root, request.path);
      if ("ok" in path) return path;
      return { kind: request.kind, path: path.path };
    }
    case "run-command": {
      if (!Object.hasOwn(configuration.commands, request.command)) {
        return { ok: false, error: { code: "unknown-command" } };
      }
      const source = configuration.commands[request.command];
      if (source === undefined) return { ok: false, error: { code: "unknown-command" } };
      return { kind: request.kind, source, cwd: configuration.root };
    }
    case "git-diff":
      return { kind: request.kind, cwd: configuration.root };
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}
