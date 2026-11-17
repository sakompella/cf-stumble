import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { runAtEntryPoint } from "../run-entry-point.js";
import {
  readBackendSetting,
  writeBackendSetting,
  type BackendSetting,
  type ContainerOutcome,
  type WorkspaceBackendChange,
} from "../backend-setting.js";
import {
  afterIdleStop,
  trackedWork,
  WorkspaceIdleController,
  WORKSPACE_IDLE_STOP_MS,
} from "./idle-controller.js";
import {
  chosenExecBackend,
  computerFilesystemProvider,
  durableObjectTransactions,
  isolateShellBackend,
  ProjectRpcTarget,
  pruneWorkspaceSpills,
} from "./project/index.js";
import { WorkspacePlatform } from "./workspace-platform.js";
import {
  resetWorkspaceStorage,
  WORKSPACE_BUSY,
  type WorkspaceResetResult,
} from "./workspace-reset.js";
import {
  ComputerWorkspaceOperations,
  ensureManagedInstructions,
  checkGitHubRepositoryAccess,
  executeHarnessBuildDiscard,
  executeHarnessBuildOutput,
  executeHarnessBuildStep,
  executeProjectProvisionRequest,
  executeProjectRemovalRequest,
  harnessBuildConfiguration,
  installGitHubCredential,
  readGitHubCredentialStatus,
  readHarnessLineage,
  UNKNOWN_LINEAGE,
  type CommandAnswer,
  type CredentialInstallResult,
  type CredentialStatusResult,
  type HarnessBuildStepRequest,
  type HarnessLineage,
  type HarnessLineageRequest,
  type InstructionsWriteResult,
  type ModuleMapAnswer,
  type ProjectProvisionAnswer,
  type ProjectProvisionRequest,
  type ProjectRemovalRequest,
  type RepositoryAccessResult,
} from "./commands/index.js";

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
  readonly CF_VERSION_METADATA?: Readonly<{ id: string }>;
}

export class WorkspaceHost extends DurableObject<WorkspaceHostEnv> {
  readonly #platform: WorkspacePlatform;
  readonly #idle: WorkspaceIdleController;
  readonly #isolateToken = crypto.randomUUID();
  readonly #harnessPermit = Semaphore.makeUnsafe(1);
  #resetting = false;

  constructor(ctx: DurableObjectState, env: WorkspaceHostEnv) {
    super(ctx, env);
    this.#platform = new WorkspacePlatform(
      ctx,
      env.ORB_PROVIDER_TOKEN,
      env.CF_VERSION_METADATA?.id ?? null,
      () => readBackendSetting(ctx.storage.kv) === "provider",
      isolateShellBackend(env.LOADER, env.ASSETS, {
        id: ctx.id,
        exports: ctx.exports,
        isolateToken: this.#isolateToken,
        workspace: () => this.#platform.workspace.stub(),
      }),
    );
    this.#idle = new WorkspaceIdleController({
      nowMs: () => Date.now(),
      idleLimitMs: WORKSPACE_IDLE_STOP_MS,
      setAlarm: (atMs) => ctx.storage.setAlarm(atMs),
      containerRunning: () => this.#platform.containerRunning(),
      pullContainer: () => this.#platform.pullContainer(),
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

  #lenient(): ComputerWorkspaceOperations {
    return new ComputerWorkspaceOperations(
      this.#platform.workspace,
      "not-required",
      this.#harnessPermit,
    );
  }

  #durable(): ComputerWorkspaceOperations {
    return new ComputerWorkspaceOperations(
      this.#platform.workspace,
      "require-complete",
      this.#harnessPermit,
    );
  }

  build(request: HarnessBuildStepRequest): Promise<CommandAnswer> {
    return this.#unlessResetting(CHANGE_REFUSED, () =>
      executeHarnessBuildStep({
        configuration: harnessBuildConfiguration(this.env.HARNESS_REPOSITORY_URL),
        operations: this.#lenient(),
        request,
      }),
    );
  }

  buildOutput(harnessCommit: string): Promise<ModuleMapAnswer> {
    return this.#unlessResetting(CHANGE_REFUSED, () =>
      executeHarnessBuildOutput({
        configuration: harnessBuildConfiguration(this.env.HARNESS_REPOSITORY_URL),
        operations: this.#lenient(),
        request: harnessCommit,
      }),
    );
  }

  discardBuild(harnessCommit: string): Promise<CommandAnswer> {
    return this.#unlessResetting(CHANGE_REFUSED, () =>
      executeHarnessBuildDiscard({
        configuration: harnessBuildConfiguration(this.env.HARNESS_REPOSITORY_URL),
        operations: this.#lenient(),
        request: harnessCommit,
      }),
    );
  }

  lineage(request: HarnessLineageRequest): Promise<HarnessLineage> {
    return this.#unlessResetting(UNKNOWN_LINEAGE, () =>
      readHarnessLineage(this.#lenient(), request),
    );
  }

  provision(request: ProjectProvisionRequest): Promise<ProjectProvisionAnswer> {
    return this.#unlessResetting(CHANGE_REFUSED, () =>
      executeProjectProvisionRequest({
        operations: this.#durable(),
        request,
      }),
    );
  }

  removeProject(request: ProjectRemovalRequest): Promise<CommandAnswer> {
    return this.#unlessResetting(CHANGE_REFUSED, () =>
      executeProjectRemovalRequest({
        operations: this.#durable(),
        request,
      }),
    );
  }

  ensureManagedInstructions(): Promise<InstructionsWriteResult> {
    return this.#unlessResetting(CHANGE_REFUSED, () => ensureManagedInstructions(this.#lenient()));
  }

  installCredential(token: string): Promise<CredentialInstallResult> {
    return this.#unlessResetting(CREDENTIAL_REFUSED, () =>
      installGitHubCredential({ lenient: this.#lenient(), durable: this.#durable() }, token),
    );
  }

  credentialStatus(): Promise<CredentialStatusResult> {
    return this.#unlessResetting(CREDENTIAL_REFUSED, () =>
      readGitHubCredentialStatus(this.#lenient()),
    );
  }

  checkRepositoryAccess(repositoryUrl: string): Promise<RepositoryAccessResult> {
    return this.#unlessResetting(CREDENTIAL_REFUSED, () =>
      checkGitHubRepositoryAccess(this.#lenient(), repositoryUrl),
    );
  }

  backend(): Promise<BackendSetting> {
    return Promise.resolve(readBackendSetting(this.ctx.storage.kv));
  }

  async setBackend(setting: BackendSetting): Promise<WorkspaceBackendChange> {
    const { inFlight, leaseEndsAtMs } = this.#idle.snapshot();

    if (this.#resetting || inFlight > 0 || leaseEndsAtMs !== null) return WORKSPACE_BUSY;

    if (setting === readBackendSetting(this.ctx.storage.kv))
      return this.#backendChanged(setting, "kept");

    const wasRunning = this.#platform.containerRunning();
    writeBackendSetting(this.ctx.storage.kv, setting);
    await this.#idle.stopForBackendChange();

    return this.#backendChanged(setting, wasRunning ? "stopped" : "not-running");
  }

  #backendChanged(backend: BackendSetting, container: ContainerOutcome): WorkspaceBackendChange {
    return { ok: true, backend, container, startsOn: this.#platform.nextContainer() };
  }

  reset(): Promise<WorkspaceResetResult> {
    if (this.#resetting || this.#idle.snapshot().inFlight > 0)
      return Promise.resolve(WORKSPACE_BUSY);

    this.#resetting = true;
    const backend = readBackendSetting(this.ctx.storage.kv);

    return this.#tracked(() =>
      resetWorkspaceStorage(
        this.ctx.storage,
        Effect.suspend(() => this.#platform.stopContainer("reset")).pipe(
          Effect.catch(({ cause }) => Effect.die(cause)),
        ),
      ).pipe(
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

  async project({ remainingMs }: Readonly<{ remainingMs: number }>): Promise<ProjectRpcTarget> {
    if (this.#resetting) throw new Error("workspace-busy: the workspace is resetting");

    const endsAtMs = Date.now() + remainingMs;
    const endLease = this.#idle.lease(endsAtMs);
    const { workspace, lifecycle } = this.#platform;

    await pruneWorkspaceSpills(workspace).catch(() => {});

    return new ProjectRpcTarget(
      computerFilesystemProvider(workspace),
      durableObjectTransactions(this.ctx.storage),
      afterIdleStop(this.#idle, chosenExecBackend(workspace, lifecycle)),
      { endsAtMs, containerState: lifecycle, activity: this.#idle, endLease },
    );
  }

  openIsolateWorkspace(token: string) {
    if (token !== this.#isolateToken) return Promise.reject(new Error("not the isolate shell"));

    return Promise.resolve(this.#platform.workspace.stub());
  }

  override fetch(request: Request): Promise<Response> {
    return runAtEntryPoint(this.#platform.handleFetch(request));
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
