/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import type { MainFacetCapabilities, MainHarnessArtifactInput } from "../facet/index.js";
import {
  GenerationControl,
  type GenerationControlResult,
  type GenerationRequest,
} from "./control/index.js";
import {
  DEFAULT_ELIGIBILITY_POLICY,
  deriveGenerationEligibility,
  type EligibilityPolicy,
  type GenerationEligibility,
} from "./eligibility.js";
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
import { HarnessArtifacts, WorkspaceHostModuleMapBuilder } from "./artifacts/index.js";
import type { BuildWorkspaceNamespace } from "./artifacts/index.js";
import {
  checkGenerationStartup,
  prepareGenerationStartup,
  type StartupCheckOptions,
  type StartupCheckResult,
} from "./startup-check/index.js";

type SupervisorEnv = {
  readonly LOADER: WorkerLoader;
  readonly MODULE_MAPS: R2Bucket;
  // The Supervisor needs one operation from the Workspace Host binding: reach a workspace by the
  // name it derives itself. Nothing here can run a project command or read a project file.
  readonly WORKSPACE_HOST: BuildWorkspaceNamespace;
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
    this.control = new GenerationControl(ctx.storage, this.generations);
    this.relayAttempts = new RelayAttempts(ctx.storage);
    this.recovery = new Recovery(ctx.storage, this.generations, this.relayAttempts);
    this.relay = new FacetRelay(this.relayAttempts);
    this.threads = new ProjectThreads(ctx.storage);
  }

  private modelRoute(): MainFacetCapabilities["MODEL"] {
    return this.ctx.exports.ModelRoute({});
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
    const generationLabel = parseGenerationLabel(label);
    if (generationLabel === undefined) {
      return {
        kind: "ineligible",
        reason: "startup-check-required",
        creditedTurns: 0,
        observationSpanMs: 0,
      };
    }

    return deriveGenerationEligibility(
      {
        generationLabel,
        latestActivationId: this.generations.latestActivationId(generationLabel),
        latestPreparationCheck: this.generations.latestPreparationCheck(generationLabel),
        attempts: this.relayAttempts.all(),
      },
      policy,
    );
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

  /** Relay one request to the generation that serves, or serve nothing when none is active. */
  override async fetch(request: Request): Promise<Response> {
    const active = this.generations.active();
    const preparationCheckId = active.generation
      ? this.generations.latestPreparationCheck(active.generation.label)?.id
      : undefined;
    const attribution = { active, preparationCheckId };
    const mainFacet = await this.artifacts.mount(
      active,
      this.env.LOADER,
      this.ctx.facets,
      this.modelRoute(),
    );

    if (mainFacet.isErr()) {
      return this.relay.recordMountFailure(mainFacet.error, attribution);
    }

    return this.relay.forward(request, mainFacet.value.fetcher, attribution);
  }
}
