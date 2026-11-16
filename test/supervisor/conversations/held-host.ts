import type { CommandAnswer } from "../../../src/workspace/commands/command-result.js";
import type { ProjectProvisionAnswer } from "../../../src/workspace/commands/provision-project.js";
import type { ProjectCapabilityStub, WorkspaceHostRpc } from "../../../src/workspace/host-rpc.js";
import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
} from "../../workspace/project/fakes.js";

export const CLONED: ProjectProvisionAnswer = { ok: true };

export const BUILT: CommandAnswer = { ok: true, output: { stdout: "", stderr: "", exitCode: 0 } };

export class HeldHost implements WorkspaceHostRpc<
  "provision" | "ensureManagedInstructions" | "build" | "project"
> {
  readonly steps: string[] = [];
  readonly turns = { ended: 0, disposed: 0 };
  clone: Promise<ProjectProvisionAnswer> = Promise.resolve(CLONED);
  answer: Promise<unknown> = Promise.resolve();
  built: Promise<CommandAnswer> = Promise.resolve(BUILT);
  cloneError: Error | undefined;
  projectError: Error | undefined;

  provision(): Promise<ProjectProvisionAnswer> {
    this.steps.push("clone");

    return this.cloneError === undefined ? this.clone : Promise.reject(this.cloneError);
  }

  ensureManagedInstructions() {
    return Promise.resolve({ ok: true, result: { kind: "written" } } as const);
  }

  build(): Promise<CommandAnswer> {
    this.steps.push("build");

    return this.built;
  }

  async project(budget: Readonly<{ remainingMs: number }>): Promise<ProjectCapabilityStub> {
    this.steps.push("project");
    await this.answer;

    if (this.projectError !== undefined) throw this.projectError;

    const target = new ProjectRpcTarget(
      new FakeProjectFilesystemProvider(),
      new FakeProjectTransactions(),
      new FakeExecBackend(),
      budget,
    );

    const endTurn = target.endTurn.bind(target);
    const turns = this.turns;

    const capability = Object.assign(target, {
      endTurn: () => {
        turns.ended += 1;

        return endTurn();
      },
      [Symbol.dispose]: () => {
        turns.disposed += 1;
      },
    });

    return Object.assign(capability, { dup: () => capability });
  }
}
