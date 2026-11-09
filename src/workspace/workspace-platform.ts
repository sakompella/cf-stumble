import {
  Workspace,
  type DurableObjectStorageLike,
  type WorkspaceBackend,
  type WorkspaceOptions,
} from "@cloudflare/computer";
import { ContainerBackend, WorkspaceContainerAPI } from "@cloudflare/computer/backends/container";
import * as Effect from "effect/Effect";
import {
  WORKSPACE_CONTAINER_INSTANCE,
  WORKSPACE_OUTPUT_OPTIONS,
} from "../../infra/worker-settings.js";
import { logEvent } from "../diagnostics.js";
import { withWorkspaceSyncIgnore, type HostedBackend } from "./backend-sync-ignore.js";
import { ContainerLifecycle } from "./container-lifecycle.js";
import { ProviderContainerAPI } from "./provider-container.js";
import { ProviderLink } from "./provider-link.js";
import { gitForwardToken, routeFetch } from "./route-fetch.js";

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
  #container: WorkspaceContainerAPI | undefined;
  readonly lifecycle = new ContainerLifecycle();
  readonly provider: ProviderLink;
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
    this.provider = new ProviderLink(state);
    this.#providerContainer = new ProviderContainerAPI(this.provider, state.id.toString());
    const gitToken = () => gitForwardToken(state.storage.kv);

    this.#containerBackend = new ContainerBackend({
      container: () => ({ getWorkspaceContainer: () => this.#cloudflareContainer() }),
      containerEnv: {
        get COMPUTER_VAR_CF_STUMBLE_GIT_TOKEN() {
          return gitToken();
        },
      },
      workspace: { binding: "WORKSPACE_HOST", id: state.id.toString() },
      egress: { mode: "direct" },
      instance: WORKSPACE_CONTAINER_INSTANCE,
    });
    this.#workspaceBackend = withWorkspaceSyncIgnore(this.#chosenBackend(), (runtimeId) => {
      this.lifecycle.connected(runtimeId);
      logEvent("info", "workspace.backend.connected", { runtimeId: runtimeId ?? null });
    });
    this.#isolate = isolate;
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

  stopContainer(reason: "idle" | "reset" | "backend"): Effect.Effect<void> {
    const container = this.#platformContainer;

    const destroy =
      container?.running === true ? Effect.promise(() => container.destroy(reason)) : Effect.void;

    return destroy.pipe(
      Effect.andThen(Effect.suspend(() => this.#stopProvider(reason))),
      Effect.andThen(
        Effect.sync(() => {
          this.lifecycle.stoppedByHost();
        }),
      ),
    );
  }

  #stopProvider(reason: "idle" | "reset" | "backend"): Effect.Effect<void> {
    if (reason === "reset" && this.provider.egressPort() !== undefined)
      return Effect.promise(() => this.#providerContainer.remove());

    return this.#providerContainer.running()
      ? Effect.promise(() => this.#providerContainer.stop())
      : Effect.void;
  }

  handleFetch(request: Request): Effect.Effect<Response> {
    return routeFetch(request, {
      token: this.#providerToken,
      provider: this.provider,
      git: {
        token: gitForwardToken(this.#state.storage.kv),
        workspace: this.workspace,
        backendId: this.#containerBackend.id,
      },
      container: this.#containerBackend,
      computerd: this.#providerBackend?.backend,
    });
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
