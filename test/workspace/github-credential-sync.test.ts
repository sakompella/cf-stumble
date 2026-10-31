import * as Effect from "effect/Effect";
import type { ExecSyncResult } from "@cloudflare/computer";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, test } from "vitest";
import { capturedEvents, everythingLogged } from "../log-capture.js";
import { WorkspaceHost } from "../../src/workspace/host.js";
import { restoreWorkspaceMembers, stubWorkspaceMember } from "./host-fixtures.js";
import { type CommandOutput } from "../../src/workspace/index.js";
import {
  executeGitHubCredentialRequest,
  type GitHubCredentialRequest,
} from "../../src/workspace/github-credential.js";
import {
  WorkspaceSyncIncomplete,
  type WorkspaceOperations,
  type WorkspacePathKind,
} from "../../src/workspace/executor.js";

afterEach(restoreWorkspaceMembers);

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

test("a failed logout does not hide the incomplete sync", async () => {
  const lenient = new RecordingOperations();
  lenient.failure = new Error("container gone");
  const strict = new RecordingOperations();
  strict.failure = new WorkspaceSyncIncomplete("pending");

  const result = await Effect.runPromise(
    executeGitHubCredentialRequest({
      operations: lenient,
      installOperations: strict,
      request: installRequest,
    }),
  );

  expect(result).toEqual({ ok: false, error: { code: "workspace-unavailable", detail: "" } });
});

function hostAnswering<T>(
  name: string,
  sync: ExecSyncResult,
  run: (host: WorkspaceHost, sources: readonly string[]) => Promise<T>,
): Promise<T> {
  const sources: string[] = [];

  const runtime = {
    exec: (source: string) => {
      sources.push(source);

      return Promise.resolve({
        result: () =>
          Promise.resolve({ stdout: "connected octocat\n", stderr: "", exitCode: 0, sync }),
      });
    },
  };

  stubWorkspaceMember("runtime", runtime);

  return runInDurableObject(env.SUPERVISOR.getByName(name), (_instance, state) => {
    Object.defineProperty(state, "container", { value: {}, configurable: true });

    return run(new WorkspaceHost(state, {}), sources);
  });
}

const complete: ExecSyncResult = { status: "complete", applied: 1, skipped: [] };

const pending: ExecSyncResult = {
  status: "pending",
  applied: 0,
  skipped: [],
  error: "pull failed",
};

test("the Host refuses an install whose workspace copy is still pending, and logs it out", async () => {
  const seen = await hostAnswering("credential-host-pending", pending, async (host, sources) => ({
    result: await host.credential(installRequest),
    sources,
  }));

  expect(seen.result).toEqual({ ok: false, error: { code: "workspace-unavailable", detail: "" } });
  expect(seen.sources).toHaveLength(2);
  expect(seen.sources[0]).toContain("gh auth login");
  expect(seen.sources[1]).toContain("gh auth logout --hostname github.com");
});

test("the Host installs once the workspace copy is complete, and its status read needs no sync", async () => {
  const installed = await hostAnswering("credential-host-complete", complete, (host) =>
    host.credential(installRequest),
  );

  const status = await hostAnswering("credential-host-status", pending, (host) =>
    host.credential({ kind: "github-credential", step: "status" }),
  );

  expect(installed).toEqual({ ok: true, result: { kind: "credential-installed" } });
  expect(status).toEqual({
    ok: true,
    result: { kind: "credential-status", state: "connected", login: "octocat" },
  });
});
