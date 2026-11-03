import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import { runAtEntryPoint } from "../run-entry-point.js";
import { afterIdleStop, trackedWork, WorkspaceIdleController } from "./idle-controller.js";
import { WORKSPACE_IDLE_STOP_MS } from "./idle-stop.js";
import {
  computerExecBackend,
  computerFilesystemProvider,
  durableObjectTransactions,
  ProjectRpcTarget,
} from "./project/index.js";
import { WorkspacePlatform } from "./workspace-platform.js";
import {
  resetWorkspaceStorage,
  WORKSPACE_BUSY,
  type WorkspaceResetResult,
} from "./workspace-reset.js";
import {
  workspaceSurfaces,
  type GitHubCredentialRequest,
  type GitHubCredentialResult,
  type HarnessBuildRequest,
  type ProjectProvisionRequest,
  type ProjectRemovalRequest,
  type InstructionsWriteResult,
  type WorkspaceCommandResult,
} from "./workspace-surfaces.js";

const CHANGE_REFUSED = { ok: false, error: { code: "workspace-busy" } } as const;

const CREDENTIAL_REFUSED = {
  ok: false,
  error: { code: "workspace-unavailable", detail: "the workspace is resetting" },
} as const;

interface WorkspaceHostEnv {
  readonly HARNESS_REPOSITORY_URL?: string;
}

export class WorkspaceHost extends DurableObject<WorkspaceHostEnv> {
  readonly #platform: WorkspacePlatform;
  readonly #idle: WorkspaceIdleController;
  #resetting = false;

  constructor(ctx: DurableObjectState, env: WorkspaceHostEnv) {
    super(ctx, env);
    this.#platform = new WorkspacePlatform(ctx);
    this.#idle = new WorkspaceIdleController({
      nowMs: () => Date.now(),
      idleLimitMs: WORKSPACE_IDLE_STOP_MS,
      setAlarm: (atMs) => ctx.storage.setAlarm(atMs),
      containerRunning: () => this.#platform.containerRunning(),
      closeWorkspace: () => this.#platform.workspace.close(),
      stopContainer: () => this.#platform.stopContainer("idle"),
    });
  }

  #tracked<A>(work: () => Effect.Effect<A>): Promise<A> {
    return runAtEntryPoint(trackedWork(this.#idle, Effect.suspend(work)));
  }

  #unlessResetting<A>(refused: A, work: () => Effect.Effect<A>): Promise<A> {
    return this.#resetting ? Promise.resolve(refused) : this.#tracked(work);
  }

  #surfaces(): ReturnType<typeof workspaceSurfaces> {
    return workspaceSurfaces(this.#platform.workspace, this.env.HARNESS_REPOSITORY_URL);
  }

  build(request: HarnessBuildRequest): Promise<WorkspaceCommandResult> {
    return this.#unlessResetting(CHANGE_REFUSED, () => this.#surfaces().build(request));
  }

  provision(request: ProjectProvisionRequest): Promise<WorkspaceCommandResult> {
    return this.#unlessResetting(CHANGE_REFUSED, () => this.#surfaces().provision(request));
  }

  removeProject(request: ProjectRemovalRequest): Promise<WorkspaceCommandResult> {
    return this.#unlessResetting(CHANGE_REFUSED, () => this.#surfaces().removeProject(request));
  }

  ensureManagedInstructions(): Promise<InstructionsWriteResult> {
    return this.#unlessResetting(CHANGE_REFUSED, () =>
      this.#surfaces().ensureManagedInstructions(),
    );
  }

  credential(request: GitHubCredentialRequest): Promise<GitHubCredentialResult> {
    return this.#unlessResetting(CREDENTIAL_REFUSED, () => this.#surfaces().credential(request));
  }

  reset(): Promise<WorkspaceResetResult> {
    if (this.#resetting || this.#idle.snapshot().inFlight > 0)
      return Promise.resolve(WORKSPACE_BUSY);

    this.#resetting = true;

    return this.#tracked(() =>
      resetWorkspaceStorage(this.ctx.storage, () => this.#platform.stopContainer("reset")).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            this.#platform.renewWorkspace();

            this.#idle.forgetAlarm();
          }),
        ),
      ),
    ).finally(() => {
      this.#resetting = false;
    });
  }

  project({ remainingMs }: Readonly<{ remainingMs: number }>): ProjectRpcTarget {
    if (this.#resetting) throw new Error("workspace-busy: the workspace is resetting");

    const endLease = this.#idle.lease(Date.now() + remainingMs);
    const { workspace, lifecycle } = this.#platform;

    return new ProjectRpcTarget(
      computerFilesystemProvider(workspace),
      durableObjectTransactions(this.ctx.storage),
      afterIdleStop(this.#idle, computerExecBackend(workspace, "container-shell", lifecycle)),
      { remainingMs, containerState: lifecycle, activity: this.#idle, endLease },
    );
  }

  mintProviderToken(): Promise<string> {
    return this.#platform.mintProviderToken();
  }

  override fetch(request: Request): Promise<Response> {
    return this.#platform.handleFetch(request);
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    this.#platform.provider.received(socket, message);
  }

  override webSocketClose(socket: WebSocket): void {
    this.#platform.provider.closed(socket);
  }

  override webSocketError(socket: WebSocket): void {
    this.#platform.provider.closed(socket);
  }

  override alarm(): Promise<void> {
    return this.#idle.onAlarm();
  }
}
