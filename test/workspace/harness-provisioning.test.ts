import { expect, test } from "vitest";
import { namespaceFor } from "../workspace-namespace-fixture.js";
import { parseHarnessCommit, type HarnessCommit } from "../../src/harness-commit.js";
import type { HarnessBuildRequest } from "../../src/harness-build.js";
import { sampleCatalog, sampleProjectOne } from "../project-fixtures.js";
import { tenantWorkspaceName } from "../../src/workspace-names.js";
import {
  provisionHarnessWorkspace,
  provisionProjectWorkspace,
  type HarnessProvisionWorkspaceHost,
  type ProvisionWorkspaceHost,
} from "../../src/workspace/provisioning.js";
import type { WorkspaceResult } from "../../src/workspace/decisions.js";

const parsedHarnessCommit = parseHarnessCommit("5000000000000000000000000000000000000003");

if (parsedHarnessCommit === undefined) {
  throw new Error("the test commit must be a valid harness commit");
}

const harnessCommit: HarnessCommit = parsedHarnessCommit;

class FakeHarnessHost implements HarnessProvisionWorkspaceHost {
  readonly builds: HarnessBuildRequest[] = [];
  instructions = 0;
  delayedBuild = false;
  private release: (() => void) | undefined;
  started: Promise<void> | undefined;
  private resolveStarted: (() => void) | undefined;

  build(request: HarnessBuildRequest): Promise<WorkspaceResult> {
    this.builds.push(request);

    if (!this.delayedBuild) {
      return Promise.resolve({
        ok: true,
        result: { kind: "command", stdout: "", stderr: "", exitCode: 0 },
      });
    }

    this.delayedBuild = false;
    this.started = new Promise((resolve) => {
      this.resolveStarted = resolve;
    });
    this.resolveStarted?.();

    return new Promise((resolve) => {
      this.release = () => {
        resolve({
          ok: true,
          result: { kind: "command", stdout: "", stderr: "", exitCode: 0 },
        });
      };
    });
  }

  ensureManagedInstructions(): Promise<WorkspaceResult> {
    this.instructions += 1;

    return Promise.resolve({ ok: true, result: { kind: "written" } });
  }

  releaseBuild(): void {
    this.release?.();
  }
}

class DelayedProjectHost implements ProvisionWorkspaceHost {
  readonly started: Promise<void>;
  private resolveStarted = () => {};
  private resolveClone: ((result: WorkspaceResult) => void) | undefined;
  readonly requests: string[] = [];

  constructor() {
    this.started = new Promise((resolve) => {
      this.resolveStarted = resolve;
    });
  }

  provision(request: { readonly step: "clone" | "instructions" }): Promise<WorkspaceResult> {
    this.requests.push(request.step);

    if (this.requests.length === 1) {
      this.resolveStarted();

      return new Promise((resolve) => {
        this.resolveClone = resolve;
      });
    }

    return Promise.resolve(
      request.step === "instructions"
        ? { ok: true, result: { kind: "written" } }
        : { ok: true, result: { kind: "command", stdout: "", stderr: "", exitCode: 0 } },
    );
  }

  release(): void {
    this.resolveClone?.({
      ok: true,
      result: { kind: "command", stdout: "", stderr: "", exitCode: 0 },
    });
  }
}

test("provisions the harness checkout and managed instructions on use", async () => {
  const host = new FakeHarnessHost();
  const workspaceName = tenantWorkspaceName("harness-provision-on-use");

  const outcome = await provisionHarnessWorkspace({
    workspaceName,
    harnessCommit,
    namespace: namespaceFor(host),
  });

  expect(outcome.isOk()).toBe(true);
  expect(host.builds).toEqual([{ kind: "build-step", harnessCommit, step: "provision" }]);
  expect(host.instructions).toBe(1);
});

test("stops harness provisioning after its turn signal aborts", async () => {
  const preHost = new FakeHarnessHost();
  const preController = new AbortController();
  preController.abort();

  const refused = await provisionHarnessWorkspace({
    workspaceName: tenantWorkspaceName("harness-provision-already-aborted"),
    harnessCommit,
    namespace: namespaceFor(preHost),
    signal: preController.signal,
  });

  expect(refused.isErr()).toBe(true);
  expect(preHost.builds).toEqual([]);

  const host = new FakeHarnessHost();
  host.delayedBuild = true;
  const controller = new AbortController();

  const provisioning = provisionHarnessWorkspace({
    workspaceName: tenantWorkspaceName("harness-provision-abort"),
    harnessCommit,
    namespace: namespaceFor(host),
    signal: controller.signal,
  });

  if (host.started === undefined) throw new Error("harness build did not start");
  await host.started;
  controller.abort();
  host.releaseBuild();

  expect((await provisioning).isErr()).toBe(true);
  expect(host.instructions).toBe(0);
});

test("excludes a harness provision while a project provision is in flight", async () => {
  const delayed = new DelayedProjectHost();
  const harness = new FakeHarnessHost();

  const host = {
    provision: delayed.provision.bind(delayed),
    build: harness.build.bind(harness),
    ensureManagedInstructions: harness.ensureManagedInstructions.bind(harness),
  } satisfies ProvisionWorkspaceHost & HarnessProvisionWorkspaceHost;

  const projectNamespace = namespaceFor<ProvisionWorkspaceHost>(host);
  const harnessNamespace = namespaceFor<HarnessProvisionWorkspaceHost>(host);

  const workspaceName = tenantWorkspaceName("harness-provision-exclusion");

  const project = provisionProjectWorkspace({
    workspaceName,
    projectId: sampleProjectOne.id,
    catalog: sampleCatalog,
    namespace: projectNamespace,
  });

  await delayed.started;

  const harnessRun = provisionHarnessWorkspace({
    workspaceName,
    harnessCommit,
    namespace: harnessNamespace,
  });

  await Promise.resolve();

  expect(harness.builds).toEqual([]);
  delayed.release();

  expect((await project).isOk()).toBe(true);
  expect((await harnessRun).isOk()).toBe(true);
  expect(harness.builds).toHaveLength(1);
  expect(harness.instructions).toBe(1);
});
