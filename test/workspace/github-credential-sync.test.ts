import { expect, test } from "vitest";
import {
  executeGitHubCredentialRequest,
  WorkspaceSyncIncomplete,
  type CommandOutput,
  type WorkspaceOperations,
  type WorkspacePathKind,
} from "../../src/workspace/index.js";

/**
 * The credential install must not report success while the workspace's durable copy of `hosts.yml`
 * is still pending, because a container replacement would then lose the credential. The Workspace
 * Host passes the install a strict operations object (`require-complete`); this file checks that
 * the surface uses it for the install only, and that the failure leaks nothing.
 */

const FAKE_TOKEN = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";

class RecordingOperations implements WorkspaceOperations {
  readonly sources: string[] = [];
  failure: Error | undefined;

  lstat(): Promise<WorkspacePathKind | undefined> {
    return Promise.resolve(void 0);
  }

  readFile(): Promise<string> {
    return Promise.reject(new Error("never read"));
  }

  writeFile(): Promise<void> {
    return Promise.reject(new Error("never written"));
  }

  runCommand(source: string): Promise<CommandOutput> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    this.sources.push(source);

    return Promise.resolve({ stdout: "installed", stderr: "", exitCode: 0 });
  }
}

test("runs the install through operations that require a complete sync, and nothing else", async () => {
  const lenient = new RecordingOperations();
  const strict = new RecordingOperations();
  const request = { kind: "github-credential", step: "install", token: FAKE_TOKEN };

  await executeGitHubCredentialRequest({ operations: lenient, installOperations: strict, request });
  await executeGitHubCredentialRequest({
    operations: lenient,
    installOperations: strict,
    request: { kind: "github-credential", step: "status" },
  });

  expect(strict.sources).toHaveLength(1);
  expect(strict.sources[0]).toContain("gh auth login");
  expect(lenient.sources).toHaveLength(1);
  expect(lenient.sources[0]).toContain("gh auth status");
});

test("an install whose workspace copy is still pending is not connected and leaks no token", async () => {
  const pendingSync = new RecordingOperations();
  pendingSync.failure = new WorkspaceSyncIncomplete(
    `post-command sync pending (exit 0, skipped 0) ${FAKE_TOKEN}`,
  );

  const result = await executeGitHubCredentialRequest({
    operations: pendingSync,
    installOperations: pendingSync,
    request: { kind: "github-credential", step: "install", token: FAKE_TOKEN },
  });

  expect(result).toEqual({ ok: false, error: { code: "workspace-unavailable", detail: "" } });
});
