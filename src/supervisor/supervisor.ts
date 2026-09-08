/// <reference types="@cloudflare/workers-types" />

// oxlint-disable max-lines -- One Durable Object class is one RPC surface: the runtime exposes the
// methods declared here, so moving a group of them into another file would either hide them from
// the binding or add a second object to route through. Each method below delegates to the module
// that owns the work.

import { DurableObject } from "cloudflare:workers";
import {
  GenerationControl,
  type GenerationControlResult,
  type GenerationRequest,
} from "./control/index.js";
import {
  DEFAULT_ELIGIBILITY_POLICY,
  generationEligibility,
  type EligibilityPolicy,
  type GenerationEligibility,
} from "./eligibility.js";
import {
  ProjectConnections,
  runProjectTurn,
  streamProjectTurn,
  tenantWorkspaceName,
  TurnCredits,
  type CompletedRealTurnCredit,
  type FacetTurnHandoff,
  type ConnectRepositoryResult,
  type CredentialWorkspaceNamespace,
  type ProvisionWorkspaceNamespace,
  type VerifiedAccessScope,
  type GitHubAuthorizationOutcome,
  type GitHubConnectionStatus,
  type ProjectListView,
  type ProjectTurnRun,
  type ProjectTurnStart,
  type ProjectWorkspaceNamespace,
  type TurnAttribution,
  type TurnStartContext,
} from "./projects/index.js";
import {
  Generations,
  parseGenerationLabel,
  type ActiveGeneration,
  type Generation,
  type PreparationCheck,
} from "./generations/index.js";
import { FacetRelay, RelayAttempts, type RelayAttempt } from "./relay/index.js";
import { ProjectThreads, type ProjectThreadResult } from "./threads/index.js";
import {
  Recovery,
  type RecoveryEpisode,
  type RecoveryFailureInput,
  type RecoveryOperationReport,
  type RecoveryOperationOutcomeInput,
  type RecoveryPolicy,
} from "./recovery/index.js";
import {
  HarnessArtifacts,
  type BuildWorkspaceNamespace,
  type MainFacetCapabilities,
  type MainHarnessArtifactInput,
} from "./artifacts/index.js";
import {
  checkGenerationStartup,
  prepareGenerationStartup,
  type StartupCheckOptions,
  type StartupCheckResult,
} from "./startup-check/index.js";

// `WORKSPACE_HOST` is one namespace, seen through narrow views of the tenant's one shared
// workspace (ADR-0038). No view can perform another's operations.
type SupervisorEnv = {
  readonly LOADER: WorkerLoader;
  readonly MODULE_MAPS: R2Bucket;
  readonly WORKSPACE_HOST: BuildWorkspaceNamespace &
    ProjectWorkspaceNamespace &
    CredentialWorkspaceNamespace &
    ProvisionWorkspaceNamespace;
  /** The GitHub OAuth app the device flow belongs to. Public configuration, not a secret. */
  readonly GITHUB_OAUTH_CLIENT_ID?: string;
  /** The documented test and development credential source. See `docs/agents/design/github-connection.md`. */
  readonly GH_TOKEN?: string;
};

/** How long one turn may hold a project's thread before another caller may take the slot over. */
export const PROJECT_TURN_LEASE_MS = 5 * 60 * 1_000;

/**
 * How long the Supervisor waits for a generation to start and then finish one turn.
 *
 * The bound exists because a disconnect signal may never arrive and a facet or its host may be
 * lost mid-turn: without it, a turn holds its lease until the lease expires and the browser waits
 * on a stream nobody will write to. It sits below {@link PROJECT_TURN_LEASE_MS} so the deadline
 * fires while the turn still owns the lease it must release, rather than after a later admission
 * has taken the slot over.
 *
 * The number is four minutes, and it is a choice made from the timings that exist rather than a
 * measurement of a turn. A turn does not build a harness: it mounts the active generation's
 * cached module map, so the cold-build figures apply to preparing a generation and not to this
 * bound. What applies is the workspace cold start, which paid evidence E8 recorded at 2.6-2.9 s
 * on the pinned Computer pair, plus the turn's own work, which is bounded by `MAX_MODEL_CALLS`
 * model calls with tool execution between them. Four minutes leaves room for that and still fails
 * fast enough to give the project back while a person is waiting.
 *
 * T1a measured the harness build chain locally at 12-15 s with an empty store and recommends 900 s
 * as its container ceiling until measured; T1b is the paid probe that would replace both that
 * ceiling and this bound with observed numbers, and T1b has not run. So this stands as a stated
 * choice, and the disconnect and deadline measurement remains open (T9 criterion 10).
 */
export const PROJECT_TURN_DEADLINE_MS = 4 * 60 * 1_000;

export class Supervisor extends DurableObject<SupervisorEnv> {
  private readonly control: GenerationControl;
  private readonly generations: Generations;
  private readonly artifacts: HarnessArtifacts;
  private readonly relayAttempts: RelayAttempts;
  /** The durable ledger of completed real turns, which is a different fact from relay evidence. */
  private readonly credits: TurnCredits;
  private readonly recovery: Recovery;
  private readonly relay: FacetRelay;
  private readonly threads: ProjectThreads;
  /** The tenant's connected repositories, their GitHub authorization, and their provisioning. */
  private readonly connections: ProjectConnections;
  /** The tenant's one workspace, named from this object's own name (`workspace-names.ts`). */
  private readonly workspaceName: string;

  constructor(ctx: DurableObjectState, env: SupervisorEnv) {
    super(ctx, env);
    this.generations = new Generations(ctx.storage);
    const supervisorName = ctx.id.name;
    if (supervisorName === undefined) {
      // A Supervisor reached by raw id has no verified tenant behind it, and its one workspace is
      // named from this object's name. Falling back to the id would mint a valid workspace name
      // for a request that never proved whose workspace it is.
      throw new Error("a Supervisor must be reached by name, not by id");
    }
    this.workspaceName = tenantWorkspaceName(supervisorName);
    this.artifacts = HarnessArtifacts.forWorkspace(
      env.MODULE_MAPS,
      env.WORKSPACE_HOST,
      this.workspaceName,
    );
    this.control = new GenerationControl(this.generations);
    this.relayAttempts = new RelayAttempts(ctx.storage);
    this.credits = new TurnCredits(ctx.storage);
    this.recovery = new Recovery(ctx.storage, this.generations, this.relayAttempts);
    this.relay = new FacetRelay(this.relayAttempts);
    this.connections = new ProjectConnections({
      storage: ctx.storage,
      workspaceName: this.workspaceName,
      namespace: env.WORKSPACE_HOST,
      environment: {
        clientId: env.GITHUB_OAUTH_CLIENT_ID,
        fallbackToken: env.GH_TOKEN,
        fetcher: (url, init) => fetch(url, init),
      },
    });
    // One catalog reaches the thread surface and the turn path, read at each call so a repository
    // connected a moment ago resolves without restarting this object.
    this.threads = new ProjectThreads(ctx.storage, () => this.connections.catalog());
  }

  private modelRoute(): MainFacetCapabilities["MODEL"] {
    return this.ctx.exports.ModelRoute({});
  }

  /** Mount one generation as a facet. Relaying and starting a project turn both use this. */
  private mountServing(active: ActiveGeneration) {
    return this.artifacts.mount(active, this.env.LOADER, this.ctx.facets, this.modelRoute());
  }

  checkGenerationStartup(
    label: number,
    artifact: MainHarnessArtifactInput,
    options?: StartupCheckOptions,
  ): Promise<StartupCheckResult> {
    return checkGenerationStartup(
      this.ctx,
      this.env.LOADER,
      this.artifacts,
      this.generations,
      label,
      artifact,
      this.modelRoute(),
      options,
    );
  }

  /**
   * Prepare a labeled generation from its harness commit: read the cached module map or build the
   * commit, then run the bounded startup check. This never changes the active generation.
   */
  prepareGeneration(label: number, options?: StartupCheckOptions): Promise<StartupCheckResult> {
    return prepareGenerationStartup(
      this.ctx,
      this.env.LOADER,
      this.artifacts,
      this.generations,
      label,
      this.modelRoute(),
      options,
    );
  }

  getActiveGeneration(): ActiveGeneration {
    return this.generations.active();
  }

  getGeneration(label: number): Generation | undefined {
    const generationLabel = parseGenerationLabel(label);
    return generationLabel === undefined ? undefined : this.generations.byLabel(generationLabel);
  }

  getGenerations(): readonly Generation[] {
    return this.generations.all();
  }

  controlGeneration(request: GenerationRequest): GenerationControlResult {
    return this.control.execute(request);
  }

  getPreparationCheckHistory(label: number): readonly PreparationCheck[] {
    const generationLabel = parseGenerationLabel(label);
    return generationLabel === undefined
      ? []
      : this.generations.preparationCheckHistory(generationLabel);
  }

  getRelayAttempts(): readonly RelayAttempt[] {
    return this.relayAttempts.all();
  }

  sweepExpiredRelayAttempts(now: number): readonly RelayAttempt[] {
    return this.relayAttempts.sweepExpired(now);
  }

  startRecovery(
    failure: RecoveryFailureInput,
    policy: RecoveryPolicy,
    now: number,
    eligibilityPolicy?: EligibilityPolicy,
  ): RecoveryEpisode {
    return this.recovery.start(failure, policy, now, eligibilityPolicy);
  }

  resumeRecovery(id: number, now: number): RecoveryEpisode {
    return this.recovery.resume(id, now);
  }

  reportRecoveryOperation(
    id: number,
    key: string,
    outcome: RecoveryOperationOutcomeInput,
    now: number,
  ): RecoveryOperationReport {
    return this.recovery.reportOperation(id, key, outcome, now);
  }

  reconcileRecoveryOperation(
    id: number,
    key: string,
    outcome: RecoveryOperationOutcomeInput,
    now: number,
  ): RecoveryOperationReport {
    return this.recovery.reconcileOperation(id, key, outcome, now);
  }

  getRecoveryEpisode(id: number): RecoveryEpisode | undefined {
    return this.recovery.get(id);
  }

  /** The latest recovery report, read only. Reading it starts, resumes, and repairs nothing. */
  getLatestRecoveryEpisode(): RecoveryEpisode | undefined {
    return this.recovery.latest();
  }

  getGenerationEligibility(
    label: number,
    policy: EligibilityPolicy = DEFAULT_ELIGIBILITY_POLICY,
  ): GenerationEligibility {
    return generationEligibility(label, this.generations, this.relayAttempts.all(), policy);
  }

  /**
   * The tenant's connected repositories, with a GitHub connection status that carries no
   * credential. This is what the page's project sidebar reads.
   */
  listProjects(now: number = Date.now()): Promise<ProjectListView> {
    return this.connections.list(now);
  }

  getGitHubConnection(now: number = Date.now()): Promise<GitHubConnectionStatus> {
    return this.connections.connectionStatus(now);
  }

  /**
   * Connect one GitHub repository to this tenant: make the workspace's credential usable, check
   * that the repository is readable through ordinary Git, then store and provision it.
   *
   * Neither argument names a tenant, a workspace, or a path. The repository URL is canonicalized
   * and the project id derived from it, so connecting the same repository twice converges on the
   * project that is already there.
   */
  connectProject(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: Durable Object RPC input is untrusted.
    repositoryUrl: unknown,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: see above.
    displayName: unknown,
    now: number = Date.now(),
  ): Promise<ConnectRepositoryResult> {
    return this.connections.connect(repositoryUrl, displayName, now);
  }

  /**
   * Start and finish the GitHub device authorization (ADR-0039, Q2). The scope is the one T3a
   * verified at the boundary, and the authorization is bound to it: a redemption presented by a
   * different verified owner, or a second redemption of a consumed code, is refused.
   */
  startGitHubAuthorization(
    scope: VerifiedAccessScope,
    now: number = Date.now(),
  ): Promise<GitHubAuthorizationOutcome> {
    return this.connections.startAuthorization(scope, now);
  }

  completeGitHubAuthorization(
    scope: VerifiedAccessScope,
    now: number = Date.now(),
  ): Promise<GitHubAuthorizationOutcome> {
    return this.connections.completeAuthorization(scope, now);
  }

  /**
   * The project thread surface. Each method takes the project id a client sent and resolves it
   * against the catalog before any row is touched (ADR-0038), so the thread a request reaches is
   * named by the server.
   */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: Durable Object RPC input is untrusted; `ProjectThreads` resolves it.
  getProjectThread(projectId: unknown): ProjectThreadResult {
    return this.threads.read(projectId);
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: see `getProjectThread`.
  startFreshProjectThread(projectId: unknown): ProjectThreadResult {
    return this.threads.startFreshThread(projectId);
  }

  /**
   * Run one authenticated project turn and stream it: admit the turn, run it on the generation
   * that serves, save what Pi ended with, and decide whether it earned a completed-real-turn
   * credit — all on this side of the boundary.
   *
   * A client sends a project id and a prompt. It cannot send a tenant, a conversation, a model,
   * or a lease: the tenant is this object, the conversation is the thread this object saved, the
   * model is the route the generation was mounted with, and the lease id is minted at admission
   * and never leaves. That is why the three lease methods and the bare streaming method this
   * replaced are gone; a browser that could hold a lease could also finish a turn it did not run.
   */
  runProjectTurn(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: see `getProjectThread`.
    projectId: unknown,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the prompt is client text; `runProjectTurn` validates it.
    prompt: unknown,
  ): Promise<ProjectTurnRun> {
    return runProjectTurn({
      projectId,
      prompt,
      threads: this.threads,
      attempts: this.relayAttempts,
      credits: this.credits,
      attribution: () => this.servingAttribution(),
      start: (project, request, context) => this.startTurnStream(project, request, context),
      now: () => Date.now(),
      leaseMs: PROJECT_TURN_LEASE_MS,
      deadlineMs: PROJECT_TURN_DEADLINE_MS,
    });
  }

  /**
   * Every completed real turn this Supervisor has recorded: Pi terminal success with a committed
   * thread save (goal criterion 6). This is a durability record and not relay evidence, so
   * `getGenerationEligibility` does not read it and a save failure cannot make a generation
   * ineligible.
   */
  getCompletedRealTurns(): readonly CompletedRealTurnCredit[] {
    return this.credits.all();
  }

  /**
   * Run one turn in the tenant's workspace, in the selected project's directory, and stream it.
   *
   * The capability and the selected project's working directory both travel to the generation as
   * arguments of its `startTurn`; nothing here is reachable from a request.
   */
  private startTurnStream(
    projectId: string,
    request: FacetTurnHandoff,
    context: TurnStartContext,
  ): Promise<ProjectTurnStart> {
    return streamProjectTurn({
      projectId,
      request,
      catalog: this.connections.catalog(),
      workspaceName: this.workspaceName,
      namespace: this.env.WORKSPACE_HOST,
      signal: context.signal,
      // The generation admission snapshotted, not the one that is active now: the turn is mounted
      // on, and recorded against, the same generation (`turn-run.ts`).
      mount: () => this.mountServing(context.attribution.active),
      // Provisioning runs on use as well as on connection: the workspace can be recreated between
      // two turns, and every step converges rather than remembering a previous run.
      provision: async (project) => (await this.connections.ensureProvisioned(project.id)).ok,
    });
  }

  /**
   * The generation a relay attempt is recorded against, read at the moment the work is admitted.
   * A turn snapshots this once, so an activation while it runs cannot relabel its evidence.
   */
  private servingAttribution(): TurnAttribution {
    const active = this.generations.active();
    const preparationCheckId = active.generation
      ? this.generations.latestPreparationCheck(active.generation.label)?.id
      : undefined;
    return { active, preparationCheckId };
  }

  /** Relay one request to the generation that serves, or serve nothing when none is active. */
  override async fetch(request: Request): Promise<Response> {
    const attribution = this.servingAttribution();
    const mainFacet = await this.mountServing(attribution.active);

    if (mainFacet.isErr()) {
      return this.relay.recordMountFailure(mainFacet.error, attribution);
    }

    return this.relay.forward(request, mainFacet.value.fetcher, attribution);
  }
}
