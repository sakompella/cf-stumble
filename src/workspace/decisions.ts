/** A plan carries a command source and directory the server chose, never caller text. It holds nothing secret, so `run-command` has no stdin field. */

export type WorkspacePlan = Readonly<{
  kind: "run-command";
  source: string;
  cwd: string;
  timeoutMs: number;
}>;

/**
 * `workspace-sync-incomplete`: the command ran but is not proven in the durable store, which is
 * what returns after container replacement. `workspace-busy`: a reset was running, so the change
 * was refused before it began.
 */
export type WorkspaceFailure = Readonly<{
  ok: false;
  error: Readonly<{
    code:
      | "invalid-request"
      | "path-outside-root"
      | "unknown-command"
      | "workspace-unavailable"
      | "workspace-busy"
      | "workspace-sync-incomplete";
  }>;
}>;

export type WorkspaceResult =
  | Readonly<{ ok: true; result: Readonly<{ kind: "written" }> }>
  | Readonly<{
      ok: true;
      result: Readonly<{
        kind: "command";
        stdout: string;
        stderr: string;
        exitCode: number;
      }>;
    }>
  | WorkspaceFailure;
