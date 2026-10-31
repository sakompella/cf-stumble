export type WorkspacePlan = Readonly<{
  kind: "run-command";
  source: string;
  cwd: string;
  timeoutMs: number;
}>;

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
