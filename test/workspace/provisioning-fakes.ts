import type {
  InstructionsWriteResult,
  WorkspaceCommandResult,
} from "../../src/workspace/commands/command-result.js";
import type { Project } from "../../src/project-catalog.js";
import { tenantWorkspaceName } from "../../src/workspace-names.js";
import {
  parseProjectProvisionRequest,
  type ProjectProvisionRequest,
} from "../../src/workspace/commands/provision-project.js";
import { ProvisionFence } from "../../src/supervisor/readiness/provision-fence.js";
import { provisionProjectWorkspace } from "../../src/supervisor/readiness/provisioning.js";
import { sampleProjectOne } from "../project-fixtures.js";
import { namespaceFor } from "../workspace-namespace-fixture.js";
import { runToResult } from "./workspace-results.js";
import type { WorkspaceHostRpc } from "../../src/workspace/host-rpc.js";

export class FakeProvisionHost implements WorkspaceHostRpc<
  "provision" | "ensureManagedInstructions"
> {
  readonly requests: ProjectProvisionRequest[] = [];
  readonly steps: string[] = [];

  protected record(request: ProjectProvisionRequest): void {
    this.requests.push(request);
    this.steps.push("clone");
  }

  provision(request: ProjectProvisionRequest): Promise<WorkspaceCommandResult> {
    this.record(request);

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

export type DelayedProvision = Readonly<{
  host: FakeProvisionHost;
  started: Promise<void>;
  release(): void;
}>;

export function delayedProvisionHost(): DelayedProvision {
  let releaseClone: (() => void) | undefined;
  let firstCloneStarted: (() => void) | undefined;

  const started = new Promise<void>((resolve) => {
    firstCloneStarted = resolve;
  });

  const host = new (class extends FakeProvisionHost {
    calls = 0;

    override provision(request: ProjectProvisionRequest): Promise<WorkspaceCommandResult> {
      this.calls += 1;

      if (this.calls === 1) {
        this.record(request);
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

export class NeverSettlingProvisionHost extends FakeProvisionHost {
  override provision(request: ProjectProvisionRequest): Promise<WorkspaceCommandResult> {
    this.record(request);

    return new Promise(() => {});
  }
}

export class ScriptedProvisionHost extends FakeProvisionHost {
  failingStep: "clone" | "instructions" | undefined;

  override provision(request: ProjectProvisionRequest): Promise<WorkspaceCommandResult> {
    this.record(request);
    const parsed = parseProjectProvisionRequest(request);

    if ("ok" in parsed) {
      return Promise.resolve(parsed);
    }

    return Promise.resolve({
      ok: true,
      result:
        this.failingStep === "clone"
          ? {
              kind: "command",
              stdout: "",
              stderr: "fatal: could not read from remote repository",
              exitCode: 128,
            }
          : { kind: "command", stdout: "", stderr: "", exitCode: 0 },
    });
  }

  override ensureManagedInstructions(): Promise<InstructionsWriteResult> {
    this.steps.push("instructions");

    return Promise.resolve(
      this.failingStep === "instructions"
        ? { ok: false, error: { code: "workspace-unavailable" } }
        : { ok: true, result: { kind: "written" } },
    );
  }
}

export const TENANT_WORKSPACE = tenantWorkspaceName("supervisor-name-of-tenant-1");

export function provisionerFor(host: WorkspaceHostRpc<"provision" | "ensureManagedInstructions">) {
  const namespace = namespaceFor(host);
  const fence = new ProvisionFence();

  return {
    namespace,
    provision: (project: Project = sampleProjectOne) =>
      runToResult(
        provisionProjectWorkspace({ workspaceName: TENANT_WORKSPACE, fence, project, namespace }),
      ),
  };
}
