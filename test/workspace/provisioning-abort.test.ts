import { expect, test, vi } from "vitest";
import { namespaceFor } from "../workspace-namespace-fixture.js";
import { sampleProjectOne } from "../project-fixtures.js";
import { tenantWorkspaceName } from "../../src/workspace-names.js";
import { provisionProjectWorkspace } from "../../src/supervisor/readiness/provisioning.js";
import { WORKSPACE_RPC_TIMEOUT_MS } from "../../src/workspace-command-timeout.js";
import { delayedProvisionHost, NeverSettlingProvisionHost } from "./provisioning-fakes.js";
import { runInterruptible } from "./workspace-results.js";

test("an interrupted provision finishes its running step and starts no next step", async () => {
  const delayed = delayedProvisionHost();

  const provisioning = runInterruptible(
    provisionProjectWorkspace({
      workspaceName: tenantWorkspaceName("provisioning-interrupted-at-boundary"),
      project: sampleProjectOne,
      namespace: namespaceFor(delayed.host),
    }),
  );

  await delayed.started;
  provisioning.interrupt();
  delayed.release();

  await expect(provisioning.interrupted).resolves.toBe(true);
  expect(delayed.host.steps).toEqual(["clone"]);
});

test("an interrupted provision waits for a lost RPC no longer than the RPC timeout", async () => {
  vi.useFakeTimers();

  const provisioning = runInterruptible(
    provisionProjectWorkspace({
      workspaceName: tenantWorkspaceName("provisioning-interrupt-bounded"),
      project: sampleProjectOne,
      namespace: namespaceFor(new NeverSettlingProvisionHost()),
    }),
  );

  let settled = false;

  void provisioning.interrupted.then(() => {
    settled = true;
  });
  provisioning.interrupt();

  await vi.advanceTimersByTimeAsync(WORKSPACE_RPC_TIMEOUT_MS / 2);
  expect(settled, "the fence stays held while the clone RPC can still answer").toBe(false);

  await vi.advanceTimersByTimeAsync(WORKSPACE_RPC_TIMEOUT_MS);
  expect(settled).toBe(true);
  vi.useRealTimers();
});
