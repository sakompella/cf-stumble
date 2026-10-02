import { afterEach, expect, test, vi } from "vitest";
import { capturedEvents, everythingLogged } from "../log-capture.js";
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

afterEach(() => {
  vi.restoreAllMocks();
});

const FAKE_TOKEN = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";

class RecordingOperations implements WorkspaceOperations {
  readonly sources: string[] = [];
  /** Set to make every command run and then fail, as a pending post-command sync does. */
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
    this.sources.push(source);

    return this.failure === undefined
      ? Promise.resolve({ stdout: "installed", stderr: "", exitCode: 0 })
      : Promise.reject(this.failure);
  }
}

const installRequest = { kind: "github-credential", step: "install", token: FAKE_TOKEN };

test("runs the install through operations that require a complete sync, and nothing else", async () => {
  const lenient = new RecordingOperations();
  const strict = new RecordingOperations();

  await executeGitHubCredentialRequest({
    operations: lenient,
    installOperations: strict,
    request: installRequest,
  });
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

test("an install whose workspace copy is still pending logs the credential out and is not connected", async () => {
  const events = capturedEvents();
  const lenient = new RecordingOperations();
  const strict = new RecordingOperations();
  strict.failure = new WorkspaceSyncIncomplete(
    `post-command sync pending (exit 0, skipped 0) ${FAKE_TOKEN}`,
  );

  const result = await executeGitHubCredentialRequest({
    operations: lenient,
    installOperations: strict,
    request: installRequest,
  });

  expect(result).toEqual({ ok: false, error: { code: "workspace-unavailable", detail: "" } });
  expect(lenient.sources).toHaveLength(1);
  expect(lenient.sources[0]).toContain("gh auth logout --hostname github.com");
  expect(lenient.sources[0]).toContain("export GH_CONFIG_DIR=");
  expect(JSON.stringify(events())).not.toContain(FAKE_TOKEN);
  expect(everythingLogged()).not.toContain(FAKE_TOKEN);
});

test("a failed logout does not hide the incomplete sync", async () => {
  const lenient = new RecordingOperations();
  lenient.failure = new Error("container gone");
  const strict = new RecordingOperations();
  strict.failure = new WorkspaceSyncIncomplete("pending");

  const result = await executeGitHubCredentialRequest({
    operations: lenient,
    installOperations: strict,
    request: installRequest,
  });

  expect(result).toEqual({ ok: false, error: { code: "workspace-unavailable", detail: "" } });
});
