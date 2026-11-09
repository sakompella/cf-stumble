import * as Result from "effect/Result";
import { expect, test } from "vitest";
import { namespaceFor } from "../workspace-namespace-fixture.js";
import { parseHarnessCommit, type HarnessCommit } from "../../src/harness-commit.js";
import type { HarnessBuildRequest } from "../../src/harness-build.js";
import { projectIdOf, sampleProjectOne } from "../project-fixtures.js";
import { tenantWorkspaceName } from "../../src/workspace-names.js";
import {
  provisionHarnessWorkspace,
  provisionProjectWorkspace,
} from "../../src/supervisor/readiness/provisioning.js";
import type { WorkspaceCommandResult, WorkspaceHostRpc } from "../../src/workspace/index.js";
import { runToResult } from "./workspace-results.js";

type InstructionsWrite = ReturnType<
  WorkspaceHostRpc<"ensureManagedInstructions">["ensureManagedInstructions"]
>;

const parsedHarnessCommit = parseHarnessCommit("5000000000000000000000000000000000000003");

if (parsedHarnessCommit === undefined) {
  throw new Error("the test commit must be a valid harness commit");
}

const harnessCommit: HarnessCommit = parsedHarnessCommit;

const harnessProjectId = projectIdOf("harness");

class FakeHarnessHost implements WorkspaceHostRpc<"build" | "ensureManagedInstructions"> {
  readonly builds: HarnessBuildRequest[] = [];
  instructions = 0;

  build(request: HarnessBuildRequest): Promise<WorkspaceCommandResult> {
    this.builds.push(request);

    return Promise.resolve({
      ok: true,
      result: { kind: "command", stdout: "", stderr: "", exitCode: 0 },
    });
  }

  ensureManagedInstructions(): InstructionsWrite {
    this.instructions += 1;

    return Promise.resolve({ ok: true, result: { kind: "written" } });
  }
}

class DelayedProjectHost {
  readonly started: Promise<void>;
  private resolveStarted = () => {};
  private resolveClone: ((result: WorkspaceCommandResult) => void) | undefined;

  constructor() {
    this.started = new Promise((resolve) => {
      this.resolveStarted = resolve;
    });
  }

  provision(): Promise<WorkspaceCommandResult> {
    this.resolveStarted();

    return new Promise((resolve) => {
      this.resolveClone = resolve;
    });
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

  const outcome = await runToResult(
    provisionHarnessWorkspace({
      projectId: harnessProjectId,
      workspaceName,
      harnessCommit,
      namespace: namespaceFor(host),
    }),
  );

  expect(Result.isSuccess(outcome)).toBe(true);
  expect(host.builds).toEqual([{ kind: "build-step", harnessCommit, step: "provision" }]);
  expect(host.instructions).toBe(1);
});

test("does not hold a harness provision behind a project provision in flight", async () => {
  const delayed = new DelayedProjectHost();
  const harness = new FakeHarnessHost();

  const host = {
    provision: delayed.provision.bind(delayed),
    build: harness.build.bind(harness),
    ensureManagedInstructions: harness.ensureManagedInstructions.bind(harness),
  } satisfies WorkspaceHostRpc<"provision" | "build" | "ensureManagedInstructions">;

  const projectNamespace =
    namespaceFor<WorkspaceHostRpc<"provision" | "ensureManagedInstructions">>(host);

  const harnessNamespace =
    namespaceFor<WorkspaceHostRpc<"build" | "ensureManagedInstructions">>(host);

  const workspaceName = tenantWorkspaceName("harness-beside-project-provision");

  const project = runToResult(
    provisionProjectWorkspace({
      workspaceName,
      project: sampleProjectOne,
      namespace: projectNamespace,
    }),
  );

  await delayed.started;

  const harnessRun = await runToResult(
    provisionHarnessWorkspace({
      projectId: harnessProjectId,
      workspaceName,
      harnessCommit,
      namespace: harnessNamespace,
    }),
  );

  expect(Result.isSuccess(harnessRun)).toBe(true);
  expect(harness.builds).toHaveLength(1);
  delayed.release();

  expect(Result.isSuccess(await project)).toBe(true);
  expect(harness.instructions, "each plan writes the managed instructions once").toBe(2);
});
