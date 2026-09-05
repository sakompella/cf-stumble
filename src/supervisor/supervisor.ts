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
  WorkspaceHostModuleMapBuilder,
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

// `WORKSPACE_HOST` is one Durable Object namespace named through the two narrow views used here.
// The build view names the harness build workspace from a module constant; the project view
// obtains one project's capability from a workspace named after a catalog-resolved project.
// Neither view can perform the other's operations, and no request can name either workspace.
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

  constructor(ctx: DurableObjectState, env: SupervisorEnv) {
    super(ctx, env);
    this.generations = new Generations(ctx.storage);
    // A cache miss builds the labeled commit in the harness build workspace, which is a separate
    // Workspace Host from the project workspace and is named by a module constant.
    this.artifacts = new HarnessArtifacts(
      env.MODULE_MAPS,
      new WorkspaceHostModuleMapBuilder(env.WORKSPACE_HOST),
    );
    this.control = new GenerationControl(this.generations);
    this.relayAttempts = new RelayAttempts(ctx.storage);
    this.recovery = new Recovery(ctx.storage, this.generations, this.relayAttempts);
    this.relay = new FacetRelay(this.relayAttempts);
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

  startProjectTurn(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: see `getProjectThread`.
    projectId: unknown,
    expectedRevision: number,
    now: number,
    leaseMs: number,
  ): ProjectThreadResult {
    return this.threads.startTurn(projectId, expectedRevision, now, leaseMs);
  }

  finishProjectTurn(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: see `getProjectThread`.
    projectId: unknown,
    expectedRevision: number,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: a conversation arriving over RPC is parsed before it is stored.
    messages: unknown,
    now: number,
  ): ProjectThreadResult {
    return this.threads.finishTurn(projectId, expectedRevision, messages, now);
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: see `getProjectThread`.
  abandonProjectTurn(projectId: unknown): ProjectThreadResult {
    return this.threads.abandonTurn(projectId);
  }

  /**
   * Run one turn against a project's own Computer workspace and stream the frames it produces.
   *
   * This is the other half of a turn from the three lease methods above: they decide who may write
   * a project's thread and store the conversation it ends with, while this one does the work. It
   * reads and writes no thread, so a caller drives both halves — take the lease, stream the turn,
   * then save the `state.messages` the terminal frame carries, which is the `AgentMessage[]`
   * `finishProjectTurn` parses. Joining them is the next unit's work, because it has to settle
   * what a disconnected browser leaves behind (ADR-0037), not merely call the two in order.
   *
   * The workspace capability travels to the generation as an argument of its `startTurn`, and this
   * method receives none of its own: `streamProjectTurn` explains the order its steps run in.
   */
  streamProjectTurn(input: ProjectTurnRequest): Promise<ProjectTurnStart> {
    return streamProjectTurn({
      ...input,
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
