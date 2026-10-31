import type {
  InstructionsWriteResult,
  WorkspaceCommandResult,
} from "../../src/workspace/decisions.js";
import type { ProjectProvisionRequest } from "../../src/workspace/project-provision.js";
import type { ProvisionWorkspaceHost } from "../../src/workspace/provisioning.js";

export class FakeProvisionHost implements ProvisionWorkspaceHost {
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

export class LostFirstProvisionHost extends FakeProvisionHost {
  calls = 0;

  override provision(request: ProjectProvisionRequest): Promise<WorkspaceCommandResult> {
    this.calls += 1;

    if (this.calls === 1) {
      this.record(request);

      return new Promise(() => {});
    }

    return super.provision(request);
  }
}
