/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import type { WorkspaceResetResult } from "../../src/workspace/index.js";
import { connectSampleProjects, submitCandidate } from "./helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

test("resets the named workspace while preserving thread and generation state", async () => {
  const control = env.SUPERVISOR.getByName("workspace-reset-preserves-supervisor-state");
  await connectSampleProjects(control);
  await control.startFreshProjectThread("sample-project-one");
  await submitCandidate(control, "0123456789abcdef0123456789abcdef01234567");

  const threadBeforeReset = await control.getProjectThread("sample-project-one");
  const generationsBeforeReset = await control.getGenerations();
  const resetResult = { ok: true, reset: "workspace" } as const satisfies WorkspaceResetResult;
  const resetWorkspace = vi.fn(() => Promise.resolve(resetResult));

  // SAFETY: the fake implements the only RPC method resetWorkspace invokes.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion
  const workspace = { reset: resetWorkspace } as unknown as ReturnType<
    typeof env.WORKSPACE_HOST.getByName
  >;

  const getByName = vi.spyOn(env.WORKSPACE_HOST, "getByName").mockReturnValue(workspace);

  await expect(control.resetWorkspace()).resolves.toEqual(resetResult);

  expect(getByName).toHaveBeenCalledExactlyOnceWith(
    "tenant:workspace-reset-preserves-supervisor-state",
  );
  expect(resetWorkspace).toHaveBeenCalledOnce();
  expect(await control.getProjectThread("sample-project-one")).toEqual(threadBeforeReset);
  expect(await control.getGenerations()).toEqual(generationsBeforeReset);
});
