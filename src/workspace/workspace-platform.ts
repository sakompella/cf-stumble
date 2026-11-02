import {
  Workspace,
  type DurableObjectStorageLike,
  type WorkspaceBackend,
} from "@cloudflare/computer";
import {
  ContainerBackend,
  type ContainerBackendOptions,
  WorkspaceContainerAPI,
} from "@cloudflare/computer/backends/container";
import { logEvent } from "../diagnostics.js";
import { withWorkspaceSyncIgnore } from "./backend-sync-ignore.js";
import { ContainerLifecycle } from "./container-lifecycle.js";
import { WORKSPACE_CONTAINER_INSTANCE } from "./container-instance.js";

export function workspaceContainerBackendConfiguration(
  workspaceId: string,
): Pick<ContainerBackendOptions, "egress" | "workspace" | "instance"> {
  return {
    workspace: { binding: "WORKSPACE_HOST", id: workspaceId },
    egress: { mode: "direct" },
    instance: WORKSPACE_CONTAINER_INSTANCE,
  };
}

export function computerStorage(storage: DurableObjectStorage): DurableObjectStorageLike {
  function exec<Row extends object>(query: string, ...bindings: unknown[]): { toArray(): Row[] };
  function exec(query: string, ...bindings: unknown[]): { toArray(): object[] } {
    return storage.sql.exec(query, ...bindings);
  }

  return {
    sql: { exec },
    transactionSync: (closure) => storage.transactionSync(closure),
  };
}

export class WorkspacePlatform {
  readonly #container: WorkspaceContainerAPI;
  readonly lifecycle = new ContainerLifecycle();
  readonly #state: DurableObjectState;
  readonly #platformContainer: DurableObjectState["container"];
  readonly #containerBackend: ContainerBackend;
  readonly #workspaceBackend: WorkspaceBackend;
  #workspace: Workspace;

  constructor(state: DurableObjectState) {
    this.#state = state;
    this.#platformContainer = state.container;
    this.#container = new WorkspaceContainerAPI(state);
    this.#containerBackend = new ContainerBackend({
      container: () => ({ getWorkspaceContainer: () => this.#container }),
      ...workspaceContainerBackendConfiguration(state.id.toString()),
    });
    this.#workspaceBackend = withWorkspaceSyncIgnore(this.#containerBackend, (runtimeId) => {
      this.lifecycle.connected(runtimeId);
      logEvent("info", "workspace.backend.connected", { runtimeId: runtimeId ?? null });
    });
    this.#workspace = this.#newWorkspace();
  }

  get workspace(): Workspace {
    return this.#workspace;
  }

  renewWorkspace(): void {
    this.#workspace = this.#newWorkspace();
  }

  containerRunning(): boolean {
    return this.#platformContainer?.running ?? false;
  }

  async stopContainer(reason: "idle" | "reset"): Promise<void> {
    if (this.containerRunning()) await this.#platformContainer?.destroy(reason);

    this.lifecycle.stoppedByHost();
  }

  handleFetch(request: Request): Promise<Response> {
    return this.#containerBackend.handleFetch(request);
  }

  #newWorkspace(): Workspace {
    return new Workspace({
      storage: computerStorage(this.#state.storage),
      sessionId: this.#state.id.toString(),
      backends: [this.#workspaceBackend],
    });
  }
}
