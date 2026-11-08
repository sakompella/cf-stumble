import { vi } from "vitest";
import type { WorkspaceResetResult } from "../../src/workspace/index.js";
import type { GitHubCredentialResult } from "../../src/workspace/github-credential.js";
import type { WorkspaceHostRpc } from "../../src/workspace/host-rpc.js";

export function fakeWorkspace(resetResult: WorkspaceResetResult) {
  let credentialState: "connected" | "missing" = "connected";

  const credential = vi.fn((): Promise<GitHubCredentialResult> =>
    Promise.resolve({
      ok: true,
      result: {
        kind: "credential-status",
        state: credentialState,
        login: credentialState === "connected" ? "reset-user" : undefined,
      },
    }),
  );

  const resetWorkspace = vi.fn(() => {
    if (resetResult.ok) credentialState = "missing";

    return Promise.resolve(resetResult);
  });

  const workspace: WorkspaceHostRpc<"credential" | "reset"> = {
    credential,
    reset: resetWorkspace,
  };

  return { resetWorkspace, workspace };
}

export function heldWorkspace() {
  const held = { started: (): void => {}, finish: (_result: WorkspaceResetResult): void => {} };

  const started = new Promise<void>((resolve) => {
    held.started = resolve;
  });

  const answer = new Promise<WorkspaceResetResult>((resolve) => {
    held.finish = resolve;
  });

  const resetWorkspace = vi
    .fn(() => Promise.resolve<WorkspaceResetResult>({ ok: true, reset: "workspace" }))
    .mockImplementationOnce(() => {
      held.started();

      return answer;
    });

  const workspace: WorkspaceHostRpc<"reset"> = { reset: resetWorkspace };

  return { started, finish: held.finish, resetWorkspace, workspace };
}
