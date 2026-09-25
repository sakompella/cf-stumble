/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { GitHubConnectionStore } from "../../src/supervisor/projects/github-connection-store.js";
import type { WorkspaceResetResult } from "../../src/workspace/index.js";
import { connectSampleProjects, submitCandidate } from "./helpers.js";

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
    credentialState = "missing";

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
