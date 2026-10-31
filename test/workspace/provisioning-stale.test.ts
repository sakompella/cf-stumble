import * as Result from "effect/Result";
import { expect, test, vi } from "vitest";
import { namespaceFor } from "../workspace-namespace-fixture.js";
import { sampleCatalog, sampleProjectOne, sampleProjectTwo } from "../project-fixtures.js";
import { tenantWorkspaceName } from "../../src/workspace-names.js";
import { PROJECT_PROVISION_STEP_NAMES } from "../../src/project-provision.js";
import { WORKSPACE_COMMAND_TIMEOUT_MS } from "../../src/workspace-command-timeout.js";
import {
  provisionProjectWorkspace,
  PROVISION_STALE_AFTER_MS,
} from "../../src/workspace/provisioning.js";
import { delayedProvisionHost, LostFirstProvisionHost } from "./provisioning-fakes.js";
import { runToResult } from "./workspace-results.js";

test("a signal-less waiter proceeds after the Workspace Host command ceiling", async () => {
  vi.useFakeTimers();

  const host = new LostFirstProvisionHost();

  const namespace = namespaceFor(host);
  const workspaceName = tenantWorkspaceName("waits-through-stale-provision");

  try {
    void runToResult(
      provisionProjectWorkspace({
        workspaceName,
        projectId: sampleProjectOne.id,
        catalog: sampleCatalog,
        namespace,
      }),
    );
    await Promise.resolve();

    const waiter = runToResult(
      provisionProjectWorkspace({
        workspaceName,
        projectId: sampleProjectTwo.id,
        catalog: sampleCatalog,
        namespace,
      }),
    );

    const timeout = new Promise<"timed-out">((resolve) => {
      setTimeout(() => {
        resolve("timed-out");
      }, PROVISION_STALE_AFTER_MS + 1);
    });

    vi.advanceTimersByTime(PROVISION_STALE_AFTER_MS + 1);
    await vi.runAllTimersAsync();

    const outcome = await Promise.race([waiter, timeout]);

    expect(outcome).not.toBe("timed-out");

    if (outcome === "timed-out") throw new Error("waiter did not pass the stale ceiling");
    expect(Result.isSuccess(outcome)).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("clears the stale ceiling timer when a waiter finishes normally", async () => {
  vi.useFakeTimers();
  const delayed = delayedProvisionHost();
  const namespace = namespaceFor(delayed.host);

  try {
    const first = runToResult(
      provisionProjectWorkspace({
        workspaceName: tenantWorkspaceName("normal-waiter-timer"),
        projectId: sampleProjectOne.id,
        catalog: sampleCatalog,
        namespace,
      }),
    );

    await delayed.started;

    const second = runToResult(
      provisionProjectWorkspace({
        workspaceName: tenantWorkspaceName("normal-waiter-timer"),
        projectId: sampleProjectTwo.id,
        catalog: sampleCatalog,
        namespace,
      }),
    );

    await Promise.resolve();

    expect(vi.getTimerCount()).toBe(2);

    delayed.release();

    expect(Result.isSuccess(await first)).toBe(true);
    expect(Result.isSuccess(await second)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("provision stale ceiling covers the plan command budget", () => {
  expect(PROVISION_STALE_AFTER_MS).toBeGreaterThanOrEqual(
    PROJECT_PROVISION_STEP_NAMES.length * WORKSPACE_COMMAND_TIMEOUT_MS,
  );
});

test("drops an in-flight provision after the Workspace Host command ceiling", async () => {
  vi.useFakeTimers();
  const initialTime = Date.now();

  const host = new LostFirstProvisionHost();

  const namespace = namespaceFor(host);

  const input = {
    workspaceName: tenantWorkspaceName("stale-provision"),
    projectId: sampleProjectOne.id,
    catalog: sampleCatalog,
    namespace,
  };

  try {
    void runToResult(provisionProjectWorkspace(input));
    await Promise.resolve();
    vi.setSystemTime(initialTime + PROVISION_STALE_AFTER_MS + 1);

    const replacement = await runToResult(provisionProjectWorkspace(input));

    expect(Result.isSuccess(replacement)).toBe(true);
    expect(host.steps).toEqual(["clone", "clone", "instructions"]);
  } finally {
    vi.useRealTimers();
  }
});
