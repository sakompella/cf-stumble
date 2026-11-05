import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import { runAtEntryPoint } from "../run-entry-point.js";
import {
  readBackendSetting,
  writeBackendSetting,
  type BackendSetting,
  type WorkspaceBackendChange,
} from "../backend-setting.js";
import { afterIdleStop, trackedWork, WorkspaceIdleController } from "./idle-controller.js";
import { WORKSPACE_IDLE_STOP_MS } from "./idle-stop.js";
import {
  chosenExecBackend,
  isolateWorkspace,
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
  readonly ORB_PROVIDER_TOKEN?: string;
  readonly LOADER: WorkerLoader;
  readonly ASSETS: Fetcher;
}

export class WorkspaceHost extends DurableObject<WorkspaceHostEnv> {
  readonly #platform: WorkspacePlatform;
  readonly #idle: WorkspaceIdleController;
  readonly #isolateToken = crypto.randomUUID();
  #resetting = false;

  constructor(ctx: DurableObjectState, env: WorkspaceHostEnv) {
    super(ctx, env);
    this.#platform = new WorkspacePlatform(
      ctx,
      env.ORB_PROVIDER_TOKEN,
      () => readBackendSetting(ctx.storage.kv) === "provider",
      isolateWorkspace(env, {
        id: ctx.id,
        exports: ctx.exports,
        isolateToken: this.#isolateToken,
      }),
    );
    this.#idle = new WorkspaceIdleController({
      nowMs: () => Date.now(),
      idleLimitMs: WORKSPACE_IDLE_STOP_MS,
      setAlarm: (atMs) => ctx.storage.setAlarm(atMs),
      containerRunning: () => this.#platform.containerRunning(),
      closeWorkspace: () => this.#platform.workspace.close(),
      stopContainer: (reason) => this.#platform.stopContainer(reason),
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

  backend(): Promise<BackendSetting> {
    return Promise.resolve(readBackendSetting(this.ctx.storage.kv));
  }

  async setBackend(setting: BackendSetting): Promise<WorkspaceBackendChange> {
    const { inFlight, leaseEndsAtMs } = this.#idle.snapshot();

    if (this.#resetting || inFlight > 0 || leaseEndsAtMs !== null) return WORKSPACE_BUSY;

    if (setting === readBackendSetting(this.ctx.storage.kv)) return { ok: true, backend: setting };

    writeBackendSetting(this.ctx.storage.kv, setting);
    await this.#idle.stopForBackendChange();

    return { ok: true, backend: setting };
  }

  reset(): Promise<WorkspaceResetResult> {
    if (this.#resetting || this.#idle.snapshot().inFlight > 0)
      return Promise.resolve(WORKSPACE_BUSY);

    this.#resetting = true;
    const backend = readBackendSetting(this.ctx.storage.kv);

    return this.#tracked(() =>
      resetWorkspaceStorage(this.ctx.storage, () => this.#platform.stopContainer("reset")).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            writeBackendSetting(this.ctx.storage.kv, backend);
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
      afterIdleStop(this.#idle, chosenExecBackend(workspace, lifecycle)),
      { remainingMs, containerState: lifecycle, activity: this.#idle, endLease },
    );
  }

  openIsolateWorkspace(token: string) {
    if (token !== this.#isolateToken) return Promise.reject(new Error("not the isolate shell"));

    return Promise.resolve(this.#platform.workspace.stub());
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
