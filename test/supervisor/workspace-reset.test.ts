import { expect, test, vi } from "vitest";
import { Supervisor } from "../../src/supervisor/supervisor.js";
import type { WorkspaceResetResult } from "../../src/workspace/index.js";

test("resets only the workspace and leaves thread and generation state intact", async () => {
  const resetResult = { ok: true, reset: "workspace" } as const satisfies WorkspaceResetResult;
  const reset = vi.fn(() => Promise.resolve(resetResult));
  const connections = { resetWorkspace: vi.fn() };
  const threads = { revision: 4 };
  const generations = { epoch: 7 };

  // SAFETY: only fields read by resetWorkspace are supplied.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const subject = Object.assign(Object.create(Supervisor.prototype), {
    env: { WORKSPACE_HOST: { reset } },
    connections,
    threads,
    generations,
  }) as Supervisor;

  await expect(subject.resetWorkspace()).resolves.toEqual({ ok: true, reset: "workspace" });
  expect(reset).toHaveBeenCalledOnce();
  expect(connections.resetWorkspace).toHaveBeenCalledOnce();
  expect(threads).toEqual({ revision: 4 });
  expect(generations).toEqual({ epoch: 7 });
});
