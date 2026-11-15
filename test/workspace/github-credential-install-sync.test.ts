import * as Effect from "effect/Effect";
import { expect, test } from "vitest";
import { capturedEvents, everythingLogged } from "../log-capture.js";
import {
  executeGitHubCredentialRequest,
  type GitHubCredentialRequest,
} from "../../src/workspace/github-credential.js";
import {
  workspaceEffects,
  type PromiseOperations,
  type CommandOutput,
  WorkspaceSyncIncomplete,
  type WorkspacePathKind,
} from "./promise-operations.js";

const FAKE_TOKEN = "ghp_cfstumbleFAKEtokenFAKEtoken0123456789";

class RecordingOperations implements PromiseOperations {
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

test("an install whose workspace copy is still pending, with the token in the sync error, never logs the token", async () => {
  capturedEvents();
  const lenient = new RecordingOperations();
  const strict = new RecordingOperations();
  strict.failure = new WorkspaceSyncIncomplete({
    message: `post-command sync pending (exit 0, skipped 0) ${FAKE_TOKEN}`,
  });

  const result = await Effect.runPromise(
    executeGitHubCredentialRequest({
      operations: workspaceEffects(lenient),
      installOperations: workspaceEffects(strict),
      request: installRequest,
    }),
  );

  expect(result).toEqual({ ok: false, error: { code: "workspace-unavailable", detail: "" } });
  expect(everythingLogged()).not.toContain(FAKE_TOKEN);
});

async function outcomeWhenLogout(logoutFailure?: Error) {
  const lenient = new RecordingOperations();
  lenient.failure = logoutFailure;
  const strict = new RecordingOperations();
  strict.failure = new WorkspaceSyncIncomplete({ message: "pending" });

  const result = await Effect.runPromise(
    executeGitHubCredentialRequest({
      operations: workspaceEffects(lenient),
      installOperations: workspaceEffects(strict),
      request: installRequest,
    }),
  );

  return {
    result,
    logouts: lenient.sources.filter((source) => source.includes("gh auth logout")),
  };
}

test("a failed logout leaves the same answer as a successful one and keeps its cause out of the answer", async () => {
  const succeeded = await outcomeWhenLogout();
  const failed = await outcomeWhenLogout(new Error("container gone"));

  expect(failed.logouts).toHaveLength(1);
  expect(failed.result.ok).toBe(false);
  expect(failed.result).toEqual(succeeded.result);
  expect(JSON.stringify(failed.result)).not.toContain("container gone");
});
