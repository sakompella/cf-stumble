import { RpcStub } from "cloudflare:workers";
import { ProjectRpcTarget } from "../../../src/workspace/project/index.js";
import {
  FakeExecBackend,
  FakeProjectFilesystemProvider,
  FakeProjectTransactions,
} from "../../workspace/project/fakes.js";
import { FakeTenantWorkspace } from "../projects/fake-tenant-workspace.js";

class UnkillableProjectTarget extends ProjectRpcTarget {
  override kill(): ReturnType<ProjectRpcTarget["kill"]> {
    return Promise.resolve({ ok: true, value: null });
  }
}

export class ProjectWorkspace extends FakeTenantWorkspace {
  readonly files = new FakeProjectFilesystemProvider();
  readonly execs = new FakeExecBackend();
  killsCommands = true;

  project() {
    const Target = this.killsCommands ? ProjectRpcTarget : UnkillableProjectTarget;

    return Promise.resolve(
      new RpcStub(new Target(this.files, new FakeProjectTransactions(), this.execs)),
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
