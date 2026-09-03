/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import {
  fixtureMainHarnessCommit,
  type MainFacetCapabilities,
  type MainHarnessArtifactInput,
} from "../facet/index.js";
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
import { RelayAttempts, type RelayAttempt } from "./relay/index.js";
import {
  executeSessionTurn,
  SessionStore,
  type SessionRecord,
  type SessionResult,
  type SessionTurnOptions,
  type SessionTurnResult,
  type SessionFacetMount,
} from "./sessions/index.js";
import {
  Recovery,
  type RecoveryEpisode,
  type RecoveryFailureInput,
  type RecoveryOperationReport,
  type RecoveryOperationOutcomeInput,
  type RecoveryPolicy,
} from "./recovery/index.js";
import { FacetRelay } from "./relay/index.js";
import { absentModuleMapBuilder, HarnessArtifacts } from "./artifacts/index.js";
import {
  checkGenerationStartup,
  prepareGenerationStartup,
  type StartupCheckOptions,
  type StartupCheckResult,
} from "./startup-check/index.js";

type SupervisorEnv = {
  readonly LOADER: WorkerLoader;
  readonly MODULE_MAPS: R2Bucket;
};

export const SESSION_TURN_LEASE_MS = 5 * 60 * 1_000;
export const SESSION_TURN_TIMEOUT_MS = 5 * 60 * 1_000;

export class Supervisor extends DurableObject<SupervisorEnv> {
  private readonly control: GenerationControl;
  private readonly generations: Generations;
  private readonly artifacts: HarnessArtifacts;
  private readonly relayAttempts: RelayAttempts;
  private readonly recovery: Recovery;
  private readonly relay: FacetRelay;
  private readonly sessions: SessionStore;

  constructor(ctx: DurableObjectState, env: SupervisorEnv) {
    super(ctx, env);
    this.generations = new Generations(ctx.storage, fixtureMainHarnessCommit);
    // No build workspace is wired yet, so a cache miss reports `build-workspace-unavailable`
    // rather than building. Passing a `WorkspaceModuleMapBuilder` here turns the build path on.
    this.artifacts = new HarnessArtifacts(env.MODULE_MAPS, absentModuleMapBuilder);
    this.control = new GenerationControl(ctx.storage, this.generations);
    this.relayAttempts = new RelayAttempts(ctx.storage);
    this.recovery = new Recovery(ctx.storage, this.generations, this.relayAttempts);
    this.relay = new FacetRelay(this.relayAttempts);
    this.sessions = new SessionStore(ctx.storage);
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

  getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  startSessionTurn(
    sessionId: string,
    expectedRevision: number,
    now: number,
    leaseMs: number,
  ): SessionResult {
    return this.sessions.startTurn(sessionId, expectedRevision, now, leaseMs);
  }

  finishSessionTurn(
    sessionId: string,
    expectedRevision: number,
    document: string,
    now: number,
  ): SessionResult {
    return this.sessions.finishTurn(sessionId, expectedRevision, document, now);
  }

  abandonSessionTurn(sessionId: string): SessionResult {
    return this.sessions.abandonTurn(sessionId);
  }

  runSessionTurn(
    sessionId: string,
    prompt: string,
    expectedRevision: number,
    options: SessionTurnOptions = {},
  ): Promise<SessionTurnResult> {
    return executeSessionTurn(
      this.sessions,
      () => this.mountSessionFacet(),
      sessionId,
      prompt,
      expectedRevision,
      options,
      options.leaseMs ?? SESSION_TURN_LEASE_MS,
      options.timeoutMs ?? SESSION_TURN_TIMEOUT_MS,
    );
  }

  private async mountSessionFacet(): Promise<SessionFacetMount> {
    const mounted = await this.artifacts.mount(
      this.generations.active(),
      this.env.LOADER,
      this.ctx.facets,
      this.modelRoute(),
    );
    return mounted.isErr() ? { ok: false } : { ok: true, fetcher: mounted.value.fetcher };
  }

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
      return this.relay.recordMountFailure(attribution);
    }

    return this.relay.forward(request, mainFacet.value.fetcher, attribution);
  }
}
