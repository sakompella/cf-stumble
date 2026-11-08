import * as Result from "effect/Result";
import { expect, test, vi } from "vitest";
import { namespaceFor } from "../workspace-namespace-fixture.js";
import { sampleProjectOne } from "../project-fixtures.js";
import { tenantWorkspaceName } from "../../src/workspace-names.js";
import { provisionProjectWorkspace } from "../../src/supervisor/readiness/provisioning.js";
import { WORKSPACE_RPC_TIMEOUT_MS } from "../../src/workspace-command-timeout.js";
import type {
  InstructionsWriteResult,
  WorkspaceCommandResult,
} from "../../src/workspace/commands/command-result.js";
import { runToResult } from "./workspace-results.js";
import type { WorkspaceHostRpc } from "../../src/workspace/host-rpc.js";

class AbortAwareHost implements WorkspaceHostRpc<"provision" | "ensureManagedInstructions"> {
  readonly steps: string[] = [];
  controller: AbortController | undefined;

  provision(): Promise<WorkspaceCommandResult> {
    this.steps.push("clone");
    this.controller?.abort();

    return Promise.resolve({
      ok: true,
      result: { kind: "command", stdout: "", stderr: "", exitCode: 0 },
    });
  }

  ensureManagedInstructions(): Promise<InstructionsWriteResult> {
    this.steps.push("instructions");

    return Promise.resolve({ ok: true, result: { kind: "written" } });
  }
}

test("does not start the next provisioning step after the turn aborts", async () => {
  const host = new AbortAwareHost();
  const controller = new AbortController();
  host.controller = controller;

  const result = await runToResult(
    provisionProjectWorkspace({
      workspaceName: tenantWorkspaceName("provisioning-abort-at-boundary"),
      project: sampleProjectOne,
      namespace: namespaceFor(host),
      signal: controller.signal,
    }),
  );

  expect(Result.isFailure(result)).toBe(true);
  expect(host.steps).toEqual(["clone"]);
});

test("bounds a running provisioning RPC after the turn aborts", async () => {
  vi.useFakeTimers();

  const host: WorkspaceHostRpc<"provision" | "ensureManagedInstructions"> = {
    provision: (request) => {
      return new Promise<WorkspaceCommandResult>(() => {
        void request;
      });
    },
    ensureManagedInstructions: () => Promise.resolve({ ok: true, result: { kind: "written" } }),
  };

  const controller = new AbortController();

  const provisioning = runToResult(
    provisionProjectWorkspace({
      workspaceName: tenantWorkspaceName("provisioning-abort-bounded"),
      project: sampleProjectOne,
      namespace: namespaceFor(host),
      signal: controller.signal,
    }),
  );

  await Promise.resolve();
  controller.abort();
  vi.advanceTimersByTime(WORKSPACE_RPC_TIMEOUT_MS);
  await vi.runAllTimersAsync();

  const result = await provisioning;
  expect(Result.isFailure(result)).toBe(true);
  vi.useRealTimers();
});
