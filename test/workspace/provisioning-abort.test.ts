import { expect, test, vi } from "vitest";
import { capturedEvents, named } from "../log-capture.js";
import { namespaceFor } from "../workspace-namespace-fixture.js";
import { sampleCatalog, sampleProjectOne } from "../project-fixtures.js";
import { tenantWorkspaceName } from "../../src/workspace-names.js";
import {
  provisionProjectWorkspace,
  PROVISION_RPC_TIMEOUT_MS,
  type ProvisionWorkspaceHost,
} from "../../src/workspace/provisioning.js";
import type { ProjectProvisionRequest } from "../../src/workspace/project-provision.js";
import type { WorkspaceResult } from "../../src/workspace/decisions.js";

class AbortAwareHost implements ProvisionWorkspaceHost {
  readonly requests: ProjectProvisionRequest[] = [];
  controller: AbortController | undefined;

  provision(request: ProjectProvisionRequest): Promise<WorkspaceResult> {
    this.requests.push(request);

    if (request.step === "clone") this.controller?.abort();

    return Promise.resolve(
      request.step === "instructions"
        ? { ok: true, result: { kind: "written" } }
        : { ok: true, result: { kind: "command", stdout: "", stderr: "", exitCode: 0 } },
    );
  }
}

test("does not start the next provisioning step after the turn aborts", async () => {
  const host = new AbortAwareHost();
  const controller = new AbortController();
  host.controller = controller;

  const result = await provisionProjectWorkspace({
    workspaceName: tenantWorkspaceName("provisioning-abort-at-boundary"),
    projectId: sampleProjectOne.id,
    catalog: sampleCatalog,
    namespace: namespaceFor(host),
    signal: controller.signal,
  });

  expect(result.isErr()).toBe(true);
  expect(host.requests.map(({ step }) => step)).toEqual(["clone"]);
});

test("bounds a running provisioning RPC after the turn aborts", async () => {
  vi.useFakeTimers();
  const events = capturedEvents();

  const host: ProvisionWorkspaceHost = {
    provision: (request) => {
      return new Promise<WorkspaceResult>(() => {
        void request;
      });
    },
  };

  const controller = new AbortController();

  const provisioning = provisionProjectWorkspace({
    workspaceName: tenantWorkspaceName("provisioning-abort-bounded"),
    projectId: sampleProjectOne.id,
    catalog: sampleCatalog,
    namespace: namespaceFor(host),
    signal: controller.signal,
  });

  await Promise.resolve();
  controller.abort();
  vi.advanceTimersByTime(PROVISION_RPC_TIMEOUT_MS);
  await vi.runAllTimersAsync();

  const result = await provisioning;
  expect(result.isErr()).toBe(true);
  expect(named(events(), "workspace.rpc").at(-1)).toMatchObject({
    outcome: "threw",
    durationMs: PROVISION_RPC_TIMEOUT_MS,
  });
  vi.useRealTimers();
});
