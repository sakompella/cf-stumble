/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { GitHubConnectionStore } from "../../src/supervisor/projects/github-connection-store.js";
import type { WorkspaceResetResult } from "../../src/workspace/index.js";
import { sampleProjectTwo } from "../project-fixtures.js";
import { connectSampleProjects, submitCandidate } from "./helpers.js";
import { startProjectTurn } from "./threads/turn-slot.js";

const NOW = 1_700_000_000_000;

const LEASE_MS = 30_000;

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

function fakeWorkspace(resetResult: WorkspaceResetResult) {
  let credentialState: "connected" | "missing" = "connected";

  const credential = vi.fn(() =>
    Promise.resolve(
      credentialState === "connected"
        ? {
            ok: true as const,
            result: {
              kind: "credential-status" as const,
              state: "connected" as const,
              login: "reset-user",
            },
          }
        : {
            ok: true as const,
            result: { kind: "credential-status" as const, state: "missing" as const },
          },
    ),
  );

  const resetWorkspace = vi.fn(() => {
    if (resetResult.ok) credentialState = "missing";

    return Promise.resolve(resetResult);
  });

  // SAFETY: the fake implements the credential and reset RPCs this test observes.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion
  const workspace = { credential, reset: resetWorkspace } as unknown as ReturnType<
    typeof env.WORKSPACE_HOST.getByName
  >;

  return { resetWorkspace, workspace };
}

test("resets the named workspace while preserving thread and generation state", async () => {
  const control = env.SUPERVISOR.getByName("workspace-reset-preserves-supervisor-state");
  await connectSampleProjects(control);
  await control.startFreshProjectThread("sample-project-one");
  await submitCandidate(control, "0123456789abcdef0123456789abcdef01234567");

  const threadBeforeReset = await control.getProjectThread("sample-project-one");
  const generationsBeforeReset = await control.getGenerations();
  await runInDurableObject(control, (_instance, state) => {
    new GitHubConnectionStore(state.storage).recordConnection({
      login: "reset-user",
      source: "configured-token",
      connectedAt: 0,
    });
  });

  const resetResult = { ok: true, reset: "workspace" } as const satisfies WorkspaceResetResult;
  const fake = fakeWorkspace(resetResult);
  const getByName = vi.spyOn(env.WORKSPACE_HOST, "getByName").mockReturnValue(fake.workspace);

  await expect(control.getGitHubConnection()).resolves.toEqual({
    state: "connected",
    login: "reset-user",
    source: "configured-token",
  });

  await expect(control.resetWorkspace()).resolves.toEqual(resetResult);

  expect(getByName).toHaveBeenCalledWith("tenant:workspace-reset-preserves-supervisor-state");
  expect(fake.resetWorkspace).toHaveBeenCalledOnce();
  await expect(control.getGitHubConnection()).resolves.toEqual({ state: "disconnected" });
  expect(await control.getProjectThread("sample-project-one")).toEqual(threadBeforeReset);
  expect(await control.getGenerations()).toEqual(generationsBeforeReset);
});

test("a live turn on any project or the harness refuses the reset before the workspace is asked", async () => {
  for (const projectId of ["sample-project-one", "harness"]) {
    const control = env.SUPERVISOR.getByName(`workspace-reset-live-turn-${projectId}`);
    await connectSampleProjects(control);
    const turn = await startProjectTurn(control, projectId, 0, NOW, LEASE_MS);

    if (!turn.ok) throw new Error(`the ${projectId} turn must be admitted`);

    const fake = fakeWorkspace({ ok: true, reset: "workspace" });
    vi.spyOn(env.WORKSPACE_HOST, "getByName").mockReturnValue(fake.workspace);

    await expect(control.resetWorkspace(NOW + 1)).resolves.toEqual({
      ok: false,
      problem: { code: "turn-active", projectId, deadlineAt: NOW + LEASE_MS },
    });
    expect(fake.resetWorkspace).not.toHaveBeenCalled();

    await expect(control.resetWorkspace(NOW + LEASE_MS)).resolves.toEqual({
      ok: true,
      reset: "workspace",
    });
    vi.restoreAllMocks();
  }
});

test("a reset the Workspace Host refuses keeps the GitHub connection record", async () => {
  const control = env.SUPERVISOR.getByName("workspace-reset-host-busy");
  await runInDurableObject(control, (_instance, state) => {
    new GitHubConnectionStore(state.storage).recordConnection({
      login: "reset-user",
      source: "configured-token",
      connectedAt: 0,
    });
  });

  const busy = { ok: false, problem: { code: "workspace-busy" } } as const;
  const fake = fakeWorkspace(busy);
  vi.spyOn(env.WORKSPACE_HOST, "getByName").mockReturnValue(fake.workspace);

  await expect(control.resetWorkspace()).resolves.toEqual(busy);
  await expect(control.getGitHubConnection()).resolves.toMatchObject({ state: "connected" });
});

/** A Workspace Host whose first reset waits until the test finishes it; later resets succeed. */
function heldWorkspace() {
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

  // SAFETY: the fake implements the reset RPC this test observes; nothing else may be reached.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion
  const workspace = { reset: resetWorkspace } as unknown as ReturnType<
    typeof env.WORKSPACE_HOST.getByName
  >;

  return { started, finish: held.finish, resetWorkspace, workspace };
}

test("while a reset runs, turns, connects, disconnects, and a second reset are refused", async () => {
  const control = env.SUPERVISOR.getByName("workspace-reset-exclusion");
  await connectSampleProjects(control);
  const fake = heldWorkspace();
  vi.spyOn(env.WORKSPACE_HOST, "getByName").mockReturnValue(fake.workspace);
  // A connect that got past the exclusion would ask GitHub for the repository size first.
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("this test reaches no network"));
  const busy = { ok: false, problem: { code: "workspace-busy" } };

  // Inside the object, because the held reset resolves from this test's own request.
  await runInDurableObject(control, async (supervisor) => {
    const resetting = supervisor.resetWorkspace();
    await fake.started;

    await expect(
      supervisor.runProjectTurn("sample-project-one", "a turn during the reset"),
    ).resolves.toEqual(busy);
    await expect(supervisor.resetWorkspace()).resolves.toEqual(busy);
    await expect(supervisor.connectProject(sampleProjectTwo.repositoryUrl, "")).resolves.toEqual({
      ok: false,
      problem: { code: "workspace-busy", detail: "" },
    });
    await expect(supervisor.disconnectProject("sample-project-one")).resolves.toEqual(busy);
    expect(fake.resetWorkspace).toHaveBeenCalledOnce();

    fake.finish({ ok: true, reset: "workspace" });
    await expect(resetting).resolves.toEqual({ ok: true, reset: "workspace" });
  });

  // The refused turn took no lease, and the exclusion ended with the reset.
  await expect(control.resetWorkspace()).resolves.toEqual({ ok: true, reset: "workspace" });
  expect((await control.getProjectThread("sample-project-one")).ok, "still connected").toBe(true);
});

test("the reset exclusion ends when the Workspace Host call throws", async () => {
  const control = env.SUPERVISOR.getByName("workspace-reset-exclusion-throws");
  const fake = fakeWorkspace({ ok: true, reset: "workspace" });
  fake.resetWorkspace.mockRejectedValueOnce(new Error("the Workspace Host went away"));
  vi.spyOn(env.WORKSPACE_HOST, "getByName").mockReturnValue(fake.workspace);

  await runInDurableObject(control, async (supervisor) => {
    await expect(supervisor.resetWorkspace()).rejects.toThrow("the Workspace Host went away");
    await expect(supervisor.resetWorkspace()).resolves.toEqual({ ok: true, reset: "workspace" });
  });
});
