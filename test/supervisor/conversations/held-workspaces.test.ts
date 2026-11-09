import { reset } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { selectableCatalog } from "../../../src/selectable-projects.js";
import type { WorkspaceCommandResult } from "../../../src/workspace/commands/command-result.js";
import { sampleProjectOne } from "../../project-fixtures.js";
import { CLONED, HeldHost } from "./held-host.js";
import { withHeldWorkspaces } from "./held-workspaces-fixture.js";

function pending<A>() {
  const settle = { resolve: (_value: A): void => {} };

  const promise = new Promise<A>((resolve) => {
    settle.resolve = resolve;
  });

  return { promise, settle };
}

const [project] = selectableCatalog([sampleProjectOne]);

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

test("a release during provisioning starts no capability RPC, so the workspace takes no turn lease", async () => {
  const host = new HeldHost();
  const clone = pending<WorkspaceCommandResult>();
  host.clone = clone.promise;

  await withHeldWorkspaces("held-release-during-provision", host, async (held) => {
    const capability = held.capability("conversation", project!, 1_000);

    await vi.waitFor(() => {
      expect(host.steps).toEqual(["clone"]);
    });
    held.end("conversation");
    clone.settle.resolve(CLONED);

    await expect(capability).rejects.toThrow("the workspace is unavailable");
    expect(host.steps).toEqual(["clone"]);
    expect(host.turns).toEqual({ ended: 0, disposed: 0 });
  });
});

test("a capability that answers after its release is ended once and never handed out", async () => {
  const host = new HeldHost();
  const answer = pending<null>();
  host.answer = answer.promise;

  await withHeldWorkspaces("held-late-capability", host, async (held) => {
    const capability = held.capability("conversation", project!, 1_000);

    await vi.waitFor(() => {
      expect(host.steps).toContain("project");
    });
    held.end("conversation");
    held.endAll();
    answer.settle.resolve(null);

    await expect(capability).rejects.toThrow("the workspace is unavailable");
    await vi.waitFor(() => {
      expect(host.turns).toEqual({ ended: 1, disposed: 1 });
    });
  });
});

test("a capability released after it was handed out is ended once", async () => {
  const host = new HeldHost();

  await withHeldWorkspaces("held-ended-once", host, async (held) => {
    await held.capability("conversation", project!, 1_000);
    held.end("conversation");
    held.end("conversation");
    held.endAll();

    await vi.waitFor(() => {
      expect(host.turns).toEqual({ ended: 1, disposed: 1 });
    });
    expect(host.steps).toEqual(["clone", "project"]);
  });
});
