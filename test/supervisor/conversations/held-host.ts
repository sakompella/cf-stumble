import type { WorkspaceCommandResult } from "../../../src/workspace/commands/command-result.js";
import type { ProjectCapabilityStub, WorkspaceHostRpc } from "../../../src/workspace/host-rpc.js";
import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
} from "../../workspace/project/fakes.js";

export const CLONED: WorkspaceCommandResult = {
  ok: true,
  result: { kind: "command", stdout: "", stderr: "", exitCode: 0 },
};

export class HeldHost implements WorkspaceHostRpc<
  "provision" | "ensureManagedInstructions" | "build" | "project"
> {
  readonly steps: string[] = [];
  readonly turns = { ended: 0, disposed: 0 };
  clone: Promise<WorkspaceCommandResult> = Promise.resolve(CLONED);
  answer: Promise<unknown> = Promise.resolve();

  provision(): Promise<WorkspaceCommandResult> {
    this.steps.push("clone");

    return this.clone;
  }

  ensureManagedInstructions() {
    return Promise.resolve({ ok: true, result: { kind: "written" } } as const);
  }

  build(): Promise<WorkspaceCommandResult> {
    return Promise.resolve(CLONED);
  }

  async project(budget: Readonly<{ remainingMs: number }>): Promise<ProjectCapabilityStub> {
    this.steps.push("project");
    await this.answer;

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
