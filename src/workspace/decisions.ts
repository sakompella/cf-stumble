/**
 * What a workspace surface decides and what it answers with.
 *
 * The build surface (`harness-build.ts`) and the provisioning surface (`project-provision.ts`)
 * each parse their own request and produce a `WorkspacePlan` from it. A plan carries a resolved
 * path or a command source the server chose, never text a caller sent, so the executor can run it
 * without deciding anything.
 */

export type WorkspacePlan =
  | Readonly<{ kind: "read-file"; path: string }>
  | Readonly<{ kind: "write-file"; path: string; content: string }>
  | Readonly<{ kind: "run-command"; source: string; cwd: string; timeoutMs: number }>;

export type WorkspaceFailure = Readonly<{
  ok: false;
  error: Readonly<{
    code: "invalid-request" | "path-outside-root" | "unknown-command" | "workspace-unavailable";
  }>;
}>;

export type WorkspaceResult =
  | Readonly<{ ok: true; result: Readonly<{ kind: "file"; content: string }> }>
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
