import {
  Workspace,
  type DurableObjectStorageLike,
  type WorkspaceBackend,
} from "@cloudflare/computer";
import { ContainerBackend, WorkspaceContainerAPI } from "@cloudflare/computer/backends/container";
import { logEvent } from "../diagnostics.js";
import { withWorkspaceSyncIgnore, type HostedBackend } from "./backend-sync-ignore.js";
import { ContainerLifecycle } from "./container-lifecycle.js";
import { WORKSPACE_CONTAINER_INSTANCE } from "./container-instance.js";
import { ORB_COMPUTERD_PATH, ORB_PROVIDER_PATH, ORB_TOKEN_HEADER } from "../orb-protocol.js";
import { ProviderContainerAPI } from "./provider-container.js";
import { ProviderLink } from "./provider-link.js";
import { providerTokenMatches } from "./provider-token.js";

type WorkspaceHostBackend = HostedBackend<Parameters<WorkspaceBackend["connect"]>[0]>;

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

type ProviderBackend = Readonly<{ egressPort: number; backend: ContainerBackend }>;

export class WorkspacePlatform {
  #container: WorkspaceContainerAPI | undefined;
  readonly lifecycle = new ContainerLifecycle();
  readonly provider: ProviderLink;
  readonly #providerContainer: ProviderContainerAPI;
  readonly #state: DurableObjectState;
  readonly #providerToken: string | undefined;
  readonly #chooseProviderPort: (connectedEgressPort: number | undefined) => number | undefined;
  readonly #platformContainer: DurableObjectState["container"];
  readonly #containerBackend: ContainerBackend;
  readonly #workspaceBackend: WorkspaceBackend;
  #providerBackend: ProviderBackend | undefined;
  #workspace: Workspace;

  constructor(
    state: DurableObjectState,
    providerToken: string | undefined,
    chooseProviderPort: (connectedEgressPort: number | undefined) => number | undefined,
  ) {
    this.#state = state;
    this.#chooseProviderPort = chooseProviderPort;
    this.#providerToken = providerToken;
    this.#platformContainer = state.container;
    this.provider = new ProviderLink(state);
    this.#providerContainer = new ProviderContainerAPI(this.provider, state.id.toString());
    this.#containerBackend = new ContainerBackend({
      container: () => ({ getWorkspaceContainer: () => this.#cloudflareContainer() }),
      workspace: { binding: "WORKSPACE_HOST", id: state.id.toString() },
      egress: { mode: "direct" },
      instance: WORKSPACE_CONTAINER_INSTANCE,
    });
    this.#workspaceBackend = withWorkspaceSyncIgnore(this.#chosenBackend(), (runtimeId) => {
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
    return (this.#platformContainer?.running ?? false) || this.#providerContainer.running();
  }

  async stopContainer(reason: "idle" | "reset"): Promise<void> {
    if (this.#platformContainer?.running === true) await this.#platformContainer.destroy(reason);

    if (reason === "reset" && this.provider.egressPort() !== undefined)
      await this.#providerContainer.remove();
    else if (this.#providerContainer.running()) await this.#providerContainer.stop();

    this.lifecycle.stoppedByHost();
  }

  async handleFetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname !== ORB_PROVIDER_PATH && pathname !== ORB_COMPUTERD_PATH)
      return this.#containerBackend.handleFetch(request);

    const token = request.headers.get(ORB_TOKEN_HEADER);

    if (!(await providerTokenMatches(this.#providerToken, token)))
      return new Response("unauthorized", { status: 401 });

    if (request.headers.get("upgrade") !== "websocket")
      return new Response("websocket upgrade required", { status: 426 });

    if (pathname === ORB_PROVIDER_PATH) return this.provider.accept();

    const backend = this.#providerBackend?.backend;

    if (backend === undefined) return new Response("no provider container", { status: 404 });

    return backend.handleFetch(new Request("http://computer.internal/api", request));
  }

  #cloudflareContainer(): WorkspaceContainerAPI {
    this.#container ??= new WorkspaceContainerAPI(this.#state);

    return this.#container;
  }

  #chosenBackend(): WorkspaceHostBackend {
    return {
      id: this.#containerBackend.id,
      type: this.#containerBackend.type,
      description: this.#containerBackend.description,
      connect: () => {
        const egressPort = this.#chooseProviderPort(this.provider.egressPort());

        logEvent("info", "workspace.backend.chosen", {
          container: egressPort === undefined ? "cloudflare" : "provider",
        });

        return egressPort === undefined
          ? this.#containerBackend.connect()
          : this.#backendFor(egressPort).connect();
      },
    };
  }

  #backendFor(egressPort: number): ContainerBackend {
    if (this.#providerBackend?.egressPort === egressPort) return this.#providerBackend.backend;

    const backend = new ContainerBackend({
      container: () => ({ getWorkspaceContainer: () => this.#providerContainer }),
      workspace: { binding: "WORKSPACE_HOST", id: this.#state.id.toString() },
      egress: { mode: "direct" },
      egressHost: `computer.internal:${egressPort}`,
      id: this.#containerBackend.id,
    });

    this.#providerBackend = { egressPort, backend };

    return backend;
  }

  #newWorkspace(): Workspace {
    return new Workspace({
      storage: computerStorage(this.#state.storage),
      sessionId: this.#state.id.toString(),
      backends: [this.#workspaceBackend],
      output: false,
    });
  }
}
