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

export type WorkspaceCommandResult =
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

export type InstructionsWriteResult =
  | Readonly<{ ok: true; result: Readonly<{ kind: "written" }> }>
  | WorkspaceFailure;
