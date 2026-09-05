/// <reference types="@cloudflare/workers-types" />

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
  streamProjectTurn,
  tenantWorkspaceName,
  type ProjectTurnRequest,
  type ProjectTurnStart,
  type ProjectWorkspaceNamespace,
} from "./projects/index.js";
import {
  Generations,
  parseGenerationLabel,
  type ActiveGeneration,
  type Generation,
  type PreparationCheck,
} from "./generations/index.js";
import { FacetRelay, RelayAttempts, type RelayAttempt } from "./relay/index.js";
import {
  ProjectThreads,
  type ProjectThreadResult,
  type ProjectTurnLeaseResult,
} from "./threads/index.js";
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

// `WORKSPACE_HOST` is one namespace, seen through two narrow views of the tenant's one shared
// workspace (ADR-0038). Neither view can perform the other's operations.
type SupervisorEnv = {
  readonly LOADER: WorkerLoader;
  readonly MODULE_MAPS: R2Bucket;
  readonly WORKSPACE_HOST: BuildWorkspaceNamespace & ProjectWorkspaceNamespace;
};

/** How long one turn may hold a project's thread before another caller may take the slot over. */
export const PROJECT_TURN_LEASE_MS = 5 * 60 * 1_000;

export class Supervisor extends DurableObject<SupervisorEnv> {
  private readonly control: GenerationControl;
  private readonly generations: Generations;
  private readonly artifacts: HarnessArtifacts;
  private readonly relayAttempts: RelayAttempts;
  private readonly recovery: Recovery;
  private readonly relay: FacetRelay;
  private readonly threads: ProjectThreads;
  /** The tenant's one workspace, named from this object's own name (`workspace-names.ts`). */
  private readonly workspaceName: string;

  constructor(ctx: DurableObjectState, env: SupervisorEnv) {
    super(ctx, env);
    this.generations = new Generations(ctx.storage);
    this.workspaceName = tenantWorkspaceName(ctx.id.name ?? ctx.id.toString());
    this.artifacts = HarnessArtifacts.forWorkspace(
      env.MODULE_MAPS,
      env.WORKSPACE_HOST,
      this.workspaceName,
    );
    this.control = new GenerationControl(this.generations);
    this.relayAttempts = new RelayAttempts(ctx.storage);
    this.recovery = new Recovery(ctx.storage, this.generations, this.relayAttempts);
    this.relay = new FacetRelay(this.relayAttempts);
    // T6a's seam: `new ProjectThreads(ctx.storage, catalog)`; a placeholder catalog resolves ids.
    this.threads = new ProjectThreads(ctx.storage);
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
   * Take the project's turn slot and receive the lease that may complete it. The lease id is
   * minted in storage and returned once, here: a caller cannot name a turn, only return the id it
   * was admitted with.
   */
  startProjectTurn(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: see `getProjectThread`.
    projectId: unknown,
    expectedRevision: number,
    now: number,
    leaseMs: number,
  ): ProjectTurnLeaseResult {
    return this.threads.startTurn(projectId, expectedRevision, now, leaseMs);
  }

  /** Save a turn's conversation. Only the lease that admitted the turn may commit it. */
  finishProjectTurn(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: see `getProjectThread`.
    projectId: unknown,
    leaseId: string,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: a conversation arriving over RPC is parsed before it is stored.
    messages: unknown,
    now: number,
  ): ProjectThreadResult {
    return this.threads.finishTurn(projectId, leaseId, messages, now);
  }

  /** Give the turn slot back without saving. Only the lease that admitted the turn may do so. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: see `getProjectThread`.
  abandonProjectTurn(projectId: unknown, leaseId: string): ProjectThreadResult {
    return this.threads.abandonTurn(projectId, leaseId);
  }

  /**
   * Run one turn in the tenant's workspace, in the selected project's directory, and stream it.
   *
   * This is the other half of a turn from the three lease methods above: they decide who may write
   * a project's thread, while this one does the work and writes no thread. A caller drives both —
   * take the lease, stream the turn, then present that lease id with the `state.messages` the
   * terminal frame carries. Joining them is the next unit's work, because it has to settle what a
   * disconnected browser leaves behind (ADR-0037) and keep the lease id server-side.
   *
   * The capability and the selected project's working directory both travel to the generation as
   * arguments of its `startTurn`; this method receives neither of its own.
   */
  streamProjectTurn(input: ProjectTurnRequest): Promise<ProjectTurnStart> {
    return streamProjectTurn({
      ...input,
      workspaceName: this.workspaceName,
      namespace: this.env.WORKSPACE_HOST,
      mount: () => this.mountServing(this.generations.active()),
    });
  }

  /** Relay one request to the generation that serves, or serve nothing when none is active. */
  override async fetch(request: Request): Promise<Response> {
    const active = this.generations.active();
    const preparationCheckId = active.generation
      ? this.generations.latestPreparationCheck(active.generation.label)?.id
      : undefined;
    const attribution = { active, preparationCheckId };
    const mainFacet = await this.mountServing(active);

    if (mainFacet.isErr()) {
      return this.relay.recordMountFailure(mainFacet.error, attribution);
    }

    return this.relay.forward(request, mainFacet.value.fetcher, attribution);
  }
}
