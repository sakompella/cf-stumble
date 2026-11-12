import {
  Workspace,
  type DurableObjectStorageLike,
  type WorkspaceBackend,
  type WorkspaceOptions,
} from "@cloudflare/computer";
import { ContainerBackend } from "@cloudflare/computer/backends/container";
import * as Effect from "effect/Effect";
import {
  WORKSPACE_CONTAINER_INSTANCE,
  WORKSPACE_OUTPUT_OPTIONS,
} from "../../infra/worker-settings.js";
import { logEvent, logRedactedCause } from "../diagnostics.js";
import { withWorkspaceSyncIgnore, type HostedBackend } from "./backend-sync-ignore.js";
import {
  CONTAINER_INACTIVITY_TIMEOUT_MS,
  ContainerLifecycle,
  ContainerStopFailed,
} from "./container-lifecycle.js";
import { snapshotBeforeStop, SnapshotContainerAPI } from "./container-snapshot.js";
import { ProviderContainerAPI } from "./provider-container.js";
import { routeFetch } from "./route-fetch.js";

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

type IsolateWorkspace = Readonly<{
  backend: WorkspaceBackend;
  git: NonNullable<WorkspaceOptions["git"]>;
}>;

export class WorkspacePlatform {
  #container: SnapshotContainerAPI | undefined;
  readonly lifecycle = new ContainerLifecycle();
  readonly #providerContainer: ProviderContainerAPI;
  readonly #state: DurableObjectState;
  readonly #providerToken: string | undefined;
  readonly #usesProvider: () => boolean;
  readonly #platformContainer: DurableObjectState["container"];
  readonly #containerBackend: ContainerBackend;
  readonly #workspaceBackend: WorkspaceBackend;
  readonly #isolate: IsolateWorkspace;
  #providerBackend: ProviderBackend | undefined;
  #workspace: Workspace;

  constructor(
    state: DurableObjectState,
    providerToken: string | undefined,
    version: string | null,
    usesProvider: () => boolean,
    isolate: IsolateWorkspace,
  ) {
    this.#state = state;
    logEvent("info", "do.started", { class: "WorkspaceHost", version });
    this.#providerToken = providerToken;
    this.#usesProvider = usesProvider;
    this.#platformContainer = state.container;
    this.#providerContainer = new ProviderContainerAPI(state);

    this.#containerBackend = new ContainerBackend({
      container: () => ({ getWorkspaceContainer: () => this.#cloudflareContainer() }),
      workspace: { binding: "WORKSPACE_HOST", id: state.id.toString() },
      egress: { mode: "direct" },
      instance: WORKSPACE_CONTAINER_INSTANCE,
    });
    this.#workspaceBackend = withWorkspaceSyncIgnore(this.#chosenBackend(), (runtimeId) => {
      this.lifecycle.connected(runtimeId);
      logEvent("info", "workspace.backend.connected", { runtimeId: runtimeId ?? null });
      this.#outliveRestart();
    });
    this.#isolate = isolate;
    this.#workspace = this.#newWorkspace();
    this.#outliveRestart();
  }

  #outliveRestart(): void {
    if (this.#platformContainer?.running !== true) return;

    this.#platformContainer
      .setInactivityTimeout(CONTAINER_INACTIVITY_TIMEOUT_MS)
      .catch((cause: unknown) => {
        logRedactedCause("workspace.container: inactivity timeout not set", cause);
      });
  }

  get provider() {
    return this.#providerContainer.link;
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

  async pullContainer(): Promise<void> {
    if (!this.lifecycle.isConnected() && this.#platformContainer?.running !== true) return;

    for await (const block of this.workspace.pull(this.#containerBackend.id)) {
      if (block.skipped > 0) throw new Error(`container pull skipped ${block.skipped} entries`);

      if (block.complete) return;
    }

    throw new Error("container pull ended incomplete");
  }

  stopContainer(reason: "idle" | "reset" | "backend"): Effect.Effect<void, ContainerStopFailed> {
    const container = this.#platformContainer;

    const destroy =
      container?.running === true
        ? this.#snapshotBeforeIdleStop(container, reason).pipe(
            Effect.andThen(
              Effect.tryPromise({
                try: () => container.destroy(reason),
                catch: (cause) => new ContainerStopFailed({ cause }),
              }),
            ),
          )
        : Effect.void;

    return destroy.pipe(
      Effect.andThen(Effect.suspend(() => this.#stopProvider(reason))),
      Effect.andThen(
        Effect.sync(() => {
          this.lifecycle.stoppedByHost();
        }),
      ),
    );
  }

  #snapshotBeforeIdleStop(container: Container, reason: string): Effect.Effect<void> {
    if (reason !== "idle") return Effect.void;

    return Effect.promise(() =>
      snapshotBeforeStop(container, this.#state.storage.kv).catch((cause: unknown) => {
        logRedactedCause("workspace.container: snapshot not taken", cause);
      }),
    );
  }

  #stopProvider(reason: "idle" | "reset" | "backend"): Effect.Effect<void, ContainerStopFailed> {
    if (reason === "reset" && this.provider.egressPort() !== undefined)
      return Effect.tryPromise({
        try: () => this.#providerContainer.remove(),
        catch: (cause) => new ContainerStopFailed({ cause }),
      });

    return this.#providerContainer.running()
      ? Effect.tryPromise({
          try: () => this.#providerContainer.stop(),
          catch: (cause) => new ContainerStopFailed({ cause }),
        })
      : Effect.void;
  }

  handleFetch(request: Request): Effect.Effect<Response> {
    return routeFetch(request, {
      token: this.#providerToken,
      provider: this.provider,
      container: this.#containerBackend,
      computerd: this.#providerBackend?.backend,
    });
  }

  #cloudflareContainer(): SnapshotContainerAPI {
    this.#container ??= new SnapshotContainerAPI(this.#state);

    return this.#container;
  }

  #chosenBackend(): WorkspaceHostBackend {
    return {
      id: this.#containerBackend.id,
      type: this.#containerBackend.type,
      description: this.#containerBackend.description,
      connect: () => {
        const egressPort = this.#usesProvider() ? this.provider.egressPort() : undefined;

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
      backends: [this.#workspaceBackend, this.#isolate.backend],
      git: this.#isolate.git,
      output: WORKSPACE_OUTPUT_OPTIONS,
    });
  }
}
