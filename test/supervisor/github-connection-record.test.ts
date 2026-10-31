import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import type { GitHubCredentialResult } from "../../src/workspace/github-credential.js";
import type { ResetWorkspaceHost } from "../../src/supervisor/supervisor-env.js";
import type { WorkspaceResetResult } from "../../src/workspace/index.js";
import type { CredentialWorkspaceHost } from "../../src/workspace/credential-access.js";
import { replaceWorkspaceHost } from "../workspace-host-spy.js";
import { connectSampleProjects } from "./helpers.js";

const NOW = 1_700_000_000_000;

const HOUR_MS = 3_600_000;

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

function workspaceAnswering(answer: GitHubCredentialResult) {
  const credential = vi.fn(() => Promise.resolve(answer));

  const getByName = replaceWorkspaceHost<CredentialWorkspaceHost>(env.WORKSPACE_HOST, {
    credential,
  });

  return { credential, getByName };
}

const CONNECTED: GitHubCredentialResult = {
  ok: true,
  result: { kind: "credential-status", state: "connected", login: "octocat" },
};

test("repeated reads of the project list and the connection never reach the Workspace Host", async () => {
  const control = env.SUPERVISOR.getByName("record-reads-stay-off-the-host");
  await connectSampleProjects(control);
  const host = workspaceAnswering(CONNECTED);

  for (let read = 0; read < 3; read += 1) {
    await control.listProjects();
    await expect(control.getGitHubConnection(NOW + read)).resolves.toEqual({
      github: null,
      checkedAt: null,
    });
  }

  expect(host.getByName).not.toHaveBeenCalled();
});

test("a refresh asks the workspace once, and later reads report what it found and when", async () => {
  const control = env.SUPERVISOR.getByName("record-refresh");
  const host = workspaceAnswering(CONNECTED);
  const connected = { state: "connected", login: "octocat", source: "device-authorization" };

  await expect(control.refreshGitHubConnection(NOW)).resolves.toEqual({
    github: connected,
    checkedAt: NOW,
  });
  await expect(control.getGitHubConnection(NOW + HOUR_MS)).resolves.toEqual({
    github: connected,
    checkedAt: NOW,
  });

  expect(host.credential).toHaveBeenCalledOnce();
});

test("a check that could not reach the workspace is the last known state, with its time", async () => {
  const control = env.SUPERVISOR.getByName("record-unavailable");
  const host = workspaceAnswering(CONNECTED);
  await control.refreshGitHubConnection(NOW);
  host.credential.mockRejectedValue(new Error("the Workspace Host went away"));
  vi.spyOn(console, "error").mockImplementation(() => {});

  await control.refreshGitHubConnection(NOW + HOUR_MS);

  await expect(control.getGitHubConnection(NOW + 2 * HOUR_MS)).resolves.toEqual({
    github: { state: "reconnect-required", reason: "workspace-unavailable" },
    checkedAt: NOW + HOUR_MS,
  });
});

function heldCheckWorkspace(resetAnswer: WorkspaceResetResult) {
  const held = { started: (): void => {}, answer: (_result: GitHubCredentialResult): void => {} };

  const started = new Promise<void>((resolve) => {
    held.started = resolve;
  });

  const answer = new Promise<GitHubCredentialResult>((resolve) => {
    held.answer = resolve;
  });

  const credential = vi.fn(() => {
    held.started();

    return answer;
  });

  const workspace: CredentialWorkspaceHost & ResetWorkspaceHost = {
    credential,
    reset: () => Promise.resolve(resetAnswer),
  };

  return { started, answer: held.answer, workspace };
}

test.each([
  {
    resetAnswer: { ok: true, reset: "workspace" },
    outcome: "a completed reset stores nothing",
    stored: { github: null, checkedAt: null },
  },
  {
    resetAnswer: { ok: false, problem: { code: "workspace-busy" } },
    outcome: "a refused reset stores its answer",
    stored: {
      github: { state: "connected", login: "octocat", source: "device-authorization" },
      checkedAt: NOW,
    },
  },
] as const)("a refresh held across $outcome", async ({ resetAnswer, stored }) => {
  const control = env.SUPERVISOR.getByName(`record-refresh-across-reset-${resetAnswer.ok}`);
  const fake = heldCheckWorkspace(resetAnswer);
  replaceWorkspaceHost(env.WORKSPACE_HOST, fake.workspace);
  vi.spyOn(console, "warn").mockImplementation(() => {});

  await runInDurableObject(control, async (supervisor) => {
    const refreshing = supervisor.refreshGitHubConnection(NOW);
    await fake.started;
    await expect(supervisor.resetWorkspace()).resolves.toEqual(resetAnswer);
    fake.answer(CONNECTED);

    await expect(refreshing).resolves.toEqual(stored);
    expect(supervisor.getGitHubConnection()).toEqual(stored);
  });
});
