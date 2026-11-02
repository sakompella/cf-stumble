import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { capturedEvents, everythingLogged } from "../log-capture.js";
import type { CommandOutput } from "../../src/workspace/index.js";
import {
  executeGitHubCredentialRequest,
  type GitHubCredentialRequest,
} from "../../src/workspace/github-credential.js";
import {
  WorkspaceSyncIncomplete,
  type WorkspaceOperations,
  type WorkspacePathKind,
} from "../../src/workspace/executor.js";

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
    this.sources.push(source);

    return this.failure === undefined
      ? Promise.resolve({ stdout: "installed", stderr: "", exitCode: 0 })
      : Promise.reject(this.failure);
  }
}

const installRequest: GitHubCredentialRequest = {
  kind: "github-credential",
  step: "install",
  token: FAKE_TOKEN,
};

test("runs the install through operations that require a complete sync, and nothing else", async () => {
  const lenient = new RecordingOperations();
  const strict = new RecordingOperations();

  await Effect.runPromise(
    executeGitHubCredentialRequest({
      operations: lenient,
      installOperations: strict,
      request: installRequest,
    }),
  );
  await Effect.runPromise(
    executeGitHubCredentialRequest({
      operations: lenient,
      installOperations: strict,
      request: { kind: "github-credential", step: "status" },
    }),
  );

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

  const result = await Effect.runPromise(
    executeGitHubCredentialRequest({
      operations: lenient,
      installOperations: strict,
      request: installRequest,
    }),
  );

  expect(result).toEqual({ ok: false, error: { code: "workspace-unavailable", detail: "" } });
  expect(lenient.sources).toHaveLength(1);
  expect(lenient.sources[0]).toContain("gh auth logout --hostname github.com");
  expect(lenient.sources[0]).toContain("export GH_CONFIG_DIR=");
  expect(JSON.stringify(events())).not.toContain(FAKE_TOKEN);
  expect(everythingLogged()).not.toContain(FAKE_TOKEN);
});

async function outcomeWhenLogout(logoutFailure?: Error) {
  const lenient = new RecordingOperations();
  lenient.failure = logoutFailure;
  const strict = new RecordingOperations();
  strict.failure = new WorkspaceSyncIncomplete("pending");

  const result = await Effect.runPromise(
    executeGitHubCredentialRequest({
      operations: lenient,
      installOperations: strict,
      request: installRequest,
    }),
  );

  return {
    result,
    logouts: lenient.sources.filter((source) => source.includes("gh auth logout")),
  };
}

test("a failed logout is attempted, reaches the operator log, and leaves the same outcome as a successful one", async () => {
  capturedEvents();

  const succeeded = await outcomeWhenLogout();
  const failed = await outcomeWhenLogout(new Error("container gone"));

  expect(failed.logouts).toHaveLength(1);
  expect(failed.result.ok).toBe(false);
  expect(failed.result).toEqual(succeeded.result);
  expect(JSON.stringify(failed.result)).not.toContain("container gone");
  expect(everythingLogged()).toContain("container gone");
});
