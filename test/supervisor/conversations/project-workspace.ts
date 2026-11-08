import { RpcStub } from "cloudflare:workers";
import {
  STARTUP_CHECK_COMMAND,
  STARTUP_CHECK_CONTAINER_COMMAND,
  STARTUP_CHECK_ISOLATE_COMMAND,
  STARTUP_CHECK_OUTPUT,
} from "../../../src/startup-check-script.js";
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

const answered = (stdout: string): readonly BackendExecEvent[] => [
  ...(stdout === "" ? [] : [{ name: "stdout", data: new TextEncoder().encode(stdout) } as const]),
  { name: "exit", exitCode: 0 },
];

class StartupCheckAnsweringExecs extends FakeExecBackend {
  startupCheckOutput: readonly BackendExecEvent[] = answered(`${STARTUP_CHECK_OUTPUT}\n`);

  #answer(command: string): readonly BackendExecEvent[] | undefined {
    if (command === STARTUP_CHECK_COMMAND) return this.startupCheckOutput;

    if (command === STARTUP_CHECK_ISOLATE_COMMAND) return answered("startup-check-isolate\n");

    if (command === STARTUP_CHECK_CONTAINER_COMMAND) return answered("v22.0.0\n");

    return command.startsWith("rm -rf /workspace/.startup-check-") ? answered("") : undefined;
  }

  override exec(input: ExecBackendInput): Promise<ExecBackendHandle> {
    const events = this.#answer(input.command);

    if (events === undefined) return super.exec(input);
    const handle = new ManualExecHandle();
    handle.push(...events);
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
