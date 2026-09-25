import { expect, test, vi } from "vitest";
import { namespaceFor } from "../workspace-namespace-fixture.js";
import { sampleCatalog, sampleProjectOne, sampleProjectTwo } from "../project-fixtures.js";
import { tenantWorkspaceName } from "../../src/workspace-names.js";
import { PROJECT_PROVISION_STEP_NAMES } from "../../src/project-provision.js";
import { WORKSPACE_COMMAND_TIMEOUT_MS } from "../../src/workspace-command-timeout.js";
import {
  provisionProjectWorkspace,
  PROVISION_STALE_AFTER_MS,
  type ProvisionWorkspaceHost,
} from "../../src/workspace/provisioning.js";
import {
  planProjectProvisionRequest,
  type ProjectProvisionRequest,
} from "../../src/workspace/project-provision.js";
import type { WorkspaceResult } from "../../src/workspace/decisions.js";

class FakeProvisionHost implements ProvisionWorkspaceHost {
  readonly requests: ProjectProvisionRequest[] = [];

  provision(request: ProjectProvisionRequest): Promise<WorkspaceResult> {
    this.requests.push(request);

    return Promise.resolve(
      request.step === "instructions"
        ? { ok: true, result: { kind: "written" } }
        : { ok: true, result: { kind: "command", stdout: "", stderr: "", exitCode: 0 } },
    );
  }
}

type DelayedProvision = Readonly<{
  host: FakeProvisionHost;
  started: Promise<void>;
  release(): void;
}>;

function delayedProvisionHost(): DelayedProvision {
  let releaseClone: (() => void) | undefined;
  let firstCloneStarted: (() => void) | undefined;

  const started = new Promise<void>((resolve) => {
    firstCloneStarted = resolve;
  });

  const host = new (class extends FakeProvisionHost {
    calls = 0;

    override provision(request: ProjectProvisionRequest): Promise<WorkspaceResult> {
      this.calls += 1;

      if (this.calls === 1) {
        this.requests.push(request);
        firstCloneStarted?.();

        return new Promise((resolve) => {
          releaseClone = () => {
            resolve({
              ok: true,
              result: { kind: "command", stdout: "", stderr: "", exitCode: 0 },
            });
          };
        });
      }

      return super.provision(request);
    }
  })();

  return {
    host,
    started,
    release: () => {
      releaseClone?.();
    },
  };
}

test("serializes different projects in one shared workspace", async () => {
  const delayed = delayedProvisionHost();
  const namespace = namespaceFor(delayed.host);
  const sharedWorkspace = tenantWorkspaceName("different-projects-shared-workspace");

  const first = provisionProjectWorkspace({
    workspaceName: sharedWorkspace,
    projectId: sampleProjectOne.id,
    catalog: sampleCatalog,
    namespace,
  });

  await delayed.started;

  const second = provisionProjectWorkspace({
    workspaceName: sharedWorkspace,
    projectId: sampleProjectTwo.id,
    catalog: sampleCatalog,
    namespace,
  });

  await Promise.resolve();

  expect(delayed.host.requests.map((request) => request.step)).toEqual(["clone"]);

  delayed.release();

  expect((await first).isOk()).toBe(true);
  expect((await second).isOk()).toBe(true);
  expect(delayed.host.requests.map((request) => request.projectId)).toEqual([
    sampleProjectOne.id,
    sampleProjectOne.id,
    sampleProjectTwo.id,
    sampleProjectTwo.id,
  ]);
});

test("serializes replacement provisioning until an aborted run has finished", async () => {
  const delayed = delayedProvisionHost();
  const workspaceName = tenantWorkspaceName("provisioning-serializes-replacement");
  const controller = new AbortController();

  const first = provisionProjectWorkspace({
    workspaceName,
    projectId: sampleProjectOne.id,
    catalog: sampleCatalog,
    namespace: namespaceFor(delayed.host),
    signal: controller.signal,
  });

  await delayed.started;
  controller.abort();

  const replacement = provisionProjectWorkspace({
    workspaceName,
    projectId: sampleProjectOne.id,
    catalog: sampleCatalog,
    namespace: namespaceFor(delayed.host),
  });

  await Promise.resolve();

  expect(
    delayed.host.requests.map((request) => request.step),
    "a replacement must not enter the shared workspace while the aborted clone is in flight",
  ).toEqual(["clone"]);

  delayed.release();

  expect((await first).isErr()).toBe(true);
  expect((await replacement).isOk()).toBe(true);
  expect(delayed.host.requests.map((request) => request.step)).toEqual([
    "clone",
    "clone",
    "instructions",
  ]);
});

class NeverSettlingProvisionHost extends FakeProvisionHost {
  override provision(request: ProjectProvisionRequest): Promise<WorkspaceResult> {
    this.requests.push(request);

    return new Promise(() => {});
  }
}

test("does not queue retries behind a never-settling provision RPC", async () => {
  const host = new NeverSettlingProvisionHost();
  const namespace = namespaceFor(host);

  const first = provisionProjectWorkspace({
    workspaceName: tenantWorkspaceName("never-settling-original"),
    projectId: sampleProjectOne.id,
    catalog: sampleCatalog,
    namespace,
  });

  await Promise.resolve();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();

    const retry = provisionProjectWorkspace({
      workspaceName: tenantWorkspaceName("never-settling-original"),
      projectId: sampleProjectOne.id,
      catalog: sampleCatalog,
      namespace,
      signal: controller.signal,
    });

    controller.abort();

    const timeout = new Promise<"timed-out">((resolve) => {
      setTimeout(() => {
        resolve("timed-out");
      }, 100);
    });

    const outcome = await Promise.race([retry, timeout]);

    expect(outcome).not.toBe("timed-out");

    if (outcome !== "timed-out") {
      expect(outcome.isErr() && outcome.error.code).toBe("provision-workspace-unavailable");
    }
  }

  expect(host.requests, "retries must not append work behind the lost RPC").toHaveLength(1);
  void first;
});

test("a signal-less waiter proceeds after the Workspace Host command ceiling", async () => {
  vi.useFakeTimers();

  const host = new (class extends FakeProvisionHost {
    calls = 0;

    override provision(request: ProjectProvisionRequest): Promise<WorkspaceResult> {
      this.calls += 1;

      if (this.calls === 1) {
        this.requests.push(request);

        return new Promise(() => {});
      }

      return super.provision(request);
    }
  })();

  const namespace = namespaceFor(host);
  const workspaceName = tenantWorkspaceName("waits-through-stale-provision");

  try {
    void provisionProjectWorkspace({
      workspaceName,
      projectId: sampleProjectOne.id,
      catalog: sampleCatalog,
      namespace,
    });
    await Promise.resolve();

    const waiter = provisionProjectWorkspace({
      workspaceName,
      projectId: sampleProjectTwo.id,
      catalog: sampleCatalog,
      namespace,
    });

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
    expect(outcome.isOk()).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("clears the stale ceiling timer when a waiter finishes normally", async () => {
  vi.useFakeTimers();
  const delayed = delayedProvisionHost();
  const namespace = namespaceFor(delayed.host);

  try {
    const first = provisionProjectWorkspace({
      workspaceName: tenantWorkspaceName("normal-waiter-timer"),
      projectId: sampleProjectOne.id,
      catalog: sampleCatalog,
      namespace,
    });

    await delayed.started;

    const second = provisionProjectWorkspace({
      workspaceName: tenantWorkspaceName("normal-waiter-timer"),
      projectId: sampleProjectTwo.id,
      catalog: sampleCatalog,
      namespace,
    });

    await Promise.resolve();

    expect(vi.getTimerCount()).toBe(1);

    delayed.release();

    expect((await first).isOk()).toBe(true);
    expect((await second).isOk()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("provision stale ceiling covers the plan command budget", () => {
  const commandStepCount = PROJECT_PROVISION_STEP_NAMES.filter(
    (step) =>
      planProjectProvisionRequest({
        kind: "provision-project",
        project: sampleProjectOne,
        step,
      }).kind === "run-command",
  ).length;

  expect(commandStepCount).toBeGreaterThan(0);
  expect(PROVISION_STALE_AFTER_MS).toBeGreaterThanOrEqual(
    commandStepCount * WORKSPACE_COMMAND_TIMEOUT_MS,
  );
});

test("drops an in-flight provision after the Workspace Host command ceiling", async () => {
  vi.useFakeTimers();
  const initialTime = Date.now();

  const host = new (class extends FakeProvisionHost {
    calls = 0;

    override provision(request: ProjectProvisionRequest): Promise<WorkspaceResult> {
      this.calls += 1;

      if (this.calls === 1) {
        this.requests.push(request);

        return new Promise(() => {});
      }

      return super.provision(request);
    }
  })();

  const namespace = namespaceFor(host);

  const input = {
    workspaceName: tenantWorkspaceName("stale-provision"),
    projectId: sampleProjectOne.id,
    catalog: sampleCatalog,
    namespace,
  };

  try {
    void provisionProjectWorkspace(input);
    await Promise.resolve();
    vi.setSystemTime(initialTime + PROVISION_STALE_AFTER_MS + 1);

    const replacement = await provisionProjectWorkspace(input);

    expect(replacement.isOk()).toBe(true);
    expect(host.requests.map((request) => request.step)).toEqual([
      "clone",
      "clone",
      "instructions",
    ]);
  } finally {
    vi.useRealTimers();
  }
});
