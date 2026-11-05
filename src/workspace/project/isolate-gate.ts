import type { Workspace } from "@cloudflare/computer";
import { WorkerEntrypoint } from "cloudflare:workers";

type WorkspaceHandle = ReturnType<Workspace["stub"]>;

export interface IsolateGateProps {
  readonly id: string;
  readonly token: string;
}

interface GateHost {
  openIsolateWorkspace(token: string): Promise<WorkspaceHandle>;
}

interface GateEnv {
  readonly WORKSPACE_HOST: Readonly<{ idFromString(id: string): DurableObjectId }> & {
    get(id: DurableObjectId): GateHost;
  };
}

export class IsolateWorkspaceGate extends WorkerEntrypoint<GateEnv, IsolateGateProps> {
  getWorkspace(): Promise<WorkspaceHandle> {
    const { id, token } = this.ctx.props;

    return this.env.WORKSPACE_HOST.get(
      this.env.WORKSPACE_HOST.idFromString(id),
    ).openIsolateWorkspace(token);
  }
}
