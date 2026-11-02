import { RpcStub } from "cloudflare:workers";
import { STARTUP_CHECK_COMMAND, STARTUP_CHECK_OUTPUT } from "../../../src/startup-check-script.js";
import type {
  BackendExecEvent,
  ExecBackendHandle,
  ExecBackendInput,
} from "../../../src/workspace/project/exec-backend.js";
import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
  ManualExecHandle,
} from "../../workspace/project/fakes.js";
import { FakeTenantWorkspace } from "../projects/fake-tenant-workspace.js";

class StartupCheckAnsweringExecs extends FakeExecBackend {
  startupCheckOutput: readonly BackendExecEvent[] = [
    { name: "stdout", data: new TextEncoder().encode(`${STARTUP_CHECK_OUTPUT}\n`) },
    { name: "exit", exitCode: 0 },
  ];

  override exec(input: ExecBackendInput): Promise<ExecBackendHandle> {
    if (input.command !== STARTUP_CHECK_COMMAND) return super.exec(input);
    const handle = new ManualExecHandle();
    handle.push(...this.startupCheckOutput);
    handle.end();

    return Promise.resolve(handle);
  }
}

class UnkillableProjectTarget extends ProjectRpcTarget {
  override kill(): ReturnType<ProjectRpcTarget["kill"]> {
    return Promise.resolve({ ok: true, value: null });
  }
}

type Lease = { readonly remainingMs: number; ended: boolean };

export class ProjectWorkspace extends FakeTenantWorkspace {
  readonly files = new FakeProjectFilesystemProvider();
  readonly execs = new StartupCheckAnsweringExecs();
  readonly leases: Lease[] = [];
  killsCommands = true;

  project({ remainingMs }: Readonly<{ remainingMs: number }>) {
    const Target = this.killsCommands ? ProjectRpcTarget : UnkillableProjectTarget;
    const lease: Lease = { remainingMs, ended: false };
    this.leases.push(lease);

    const endLease = () => {
      lease.ended = true;
    };

    return Promise.resolve(
      new RpcStub(
        new Target(this.files, new FakeProjectTransactions(), this.execs, {
          remainingMs,
          endLease,
        }),
      ),
    );
  }

  seedFile(path: string, text: string): void {
    const parts = path.split("/").filter((part) => part !== "");

    for (let depth = 1; depth < parts.length; depth += 1) {
      const directory = `/${parts.slice(0, depth).join("/")}`;

      if (!this.files.nodes.has(directory))
        this.files.nodes.set(directory, { type: "dir", mtimeMs: 0 });
    }

    this.files.nodes.set(path, { type: "file", data: new TextEncoder().encode(text), mtimeMs: 0 });
  }
}
