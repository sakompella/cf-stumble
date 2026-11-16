import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import type { CredentialStatusResult } from "../../src/workspace/github-credential.js";
import type { WorkspaceResetResult } from "../../src/workspace/index.js";
import { replaceWorkspaceHost } from "../workspace-host-spy.js";
import { connectSampleProjects } from "./helpers.js";
import type { WorkspaceHostRpc } from "../../src/workspace/host-rpc.js";

afterEach(async () => {
  await reset();
});

function workspaceAnswering(answer: CredentialStatusResult) {
  const credentialStatus = vi.fn(() => Promise.resolve(answer));

  const getByName = replaceWorkspaceHost<WorkspaceHostRpc<"credentialStatus">>(env.WORKSPACE_HOST, {
    credentialStatus,
  });

  return { credentialStatus, getByName };
}

const CONNECTED: CredentialStatusResult = {
  ok: true,
  status: { state: "connected", login: "octocat" },
};

test("repeated reads of the project list and the connection never reach the Workspace Host", async () => {
  const control = env.SUPERVISOR.getByName("record-reads-stay-off-the-host");
  await connectSampleProjects(control);
  const host = workspaceAnswering(CONNECTED);

  for (let read = 0; read < 3; read += 1) {
    await control.listProjects();
    await expect(control.getGitHubConnection()).resolves.toEqual({
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

  const refreshed = await control.refreshGitHubConnection();

  expect(refreshed).toMatchObject({ ok: true, github: connected });
  await expect(control.getGitHubConnection()).resolves.toEqual({
    github: connected,
    checkedAt: refreshed.ok ? refreshed.checkedAt : null,
  });

  expect(host.credentialStatus).toHaveBeenCalledOnce();
});

test("a check that could not reach the workspace leaves the last verdict and its time standing", async () => {
  const control = env.SUPERVISOR.getByName("record-unavailable");
  const host = workspaceAnswering(CONNECTED);
  const connected = { state: "connected", login: "octocat", source: "device-authorization" };
  const refreshed = await control.refreshGitHubConnection();
  host.credentialStatus.mockRejectedValue(new Error("the Workspace Host went away"));

  await expect(control.refreshGitHubConnection()).resolves.toEqual({
    ok: false,
    problem: "workspace-unavailable",
  });

  await expect(control.getGitHubConnection()).resolves.toEqual({
    github: connected,
    checkedAt: refreshed.ok ? refreshed.checkedAt : null,
  });
});

function heldCheckWorkspace(resetAnswer: WorkspaceResetResult) {
  const held = { started: (): void => {}, answer: (_result: CredentialStatusResult): void => {} };

  const started = new Promise<void>((resolve) => {
    held.started = resolve;
  });

  const answer = new Promise<CredentialStatusResult>((resolve) => {
    held.answer = resolve;
  });

  const credentialStatus = vi.fn(() => {
    held.started();

    return answer;
  });

  const workspace: WorkspaceHostRpc<"credentialStatus" | "reset"> = {
    credentialStatus,
    reset: () => Promise.resolve(resetAnswer),
  };

  return { started, answer: held.answer, workspace };
}

test.each([
  {
    resetAnswer: { ok: true, reset: "workspace" },
    outcome: "a completed reset stores nothing",
    stored: { github: null },
  },
  {
    resetAnswer: { ok: false, problem: { code: "workspace-busy" } },
    outcome: "a refused reset stores its answer",
    stored: {
      github: { state: "connected", login: "octocat", source: "device-authorization" },
    },
  },
] as const)("a refresh held across $outcome", async ({ resetAnswer, stored }) => {
  const control = env.SUPERVISOR.getByName(`record-refresh-across-reset-${resetAnswer.ok}`);
  const fake = heldCheckWorkspace(resetAnswer);
  replaceWorkspaceHost(env.WORKSPACE_HOST, fake.workspace);

  await runInDurableObject(control, async (supervisor) => {
    const refreshing = supervisor.refreshGitHubConnection();
    await fake.started;
    await expect(supervisor.resetWorkspace()).resolves.toEqual(resetAnswer);
    fake.answer(CONNECTED);

    const refreshed = await refreshing;
    const checkedAt = refreshed.ok ? refreshed.checkedAt : undefined;

    expect(refreshed).toMatchObject({ ok: true, ...stored });
    expect(checkedAt === null).toBe(stored.github === null);
    expect(supervisor.getGitHubConnection()).toEqual({ ...stored, checkedAt });
  });
});
