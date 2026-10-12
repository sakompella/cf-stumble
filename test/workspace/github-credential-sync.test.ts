/// <reference types="@cloudflare/vitest-plugin/types" />

import * as Effect from "effect/Effect";
import { Workspace, type ExecSyncResult } from "@cloudflare/computer";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import { capturedEvents, everythingLogged } from "../log-capture.js";
import { WorkspaceHost } from "../../src/workspace/host.js";
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
 * the Host does, that the surface uses it for the install only, and that the failure leaks nothing.
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

/**
 * A real Workspace Host whose Computer runtime runs every command with exit 0 and reports `sync`
 * for the copy back into the durable workspace. Everything between the Host and that runtime is
 * the production code.
 */
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

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: this fake implements the runtime slice ComputerWorkspaceOperations uses.
  vi.spyOn(Workspace.prototype, "runtime", "get").mockReturnValue(runtime as never);

  return runInDurableObject(env.SUPERVISOR.getByName(name), (_instance, state) => {
    // The Host needs a container-enabled object to construct; no command reaches this container.
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
