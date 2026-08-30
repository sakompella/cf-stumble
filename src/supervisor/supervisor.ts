/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import {
  fixtureMainHarnessCommit,
  loadFixtureMainFacet,
  type MainHarnessArtifactInput,
  type MainHarnessArtifactProblem,
} from "../agent/loader.js";
import {
  GenerationControl,
  type GenerationControlResult,
  type GenerationRequest,
} from "./control.js";
import {
  DEFAULT_ELIGIBILITY_POLICY,
  deriveGenerationEligibility,
  type EligibilityPolicy,
  type GenerationEligibility,
} from "./eligibility.js";
import {
  Generations,
  type ActivationResult,
  type ActiveGeneration,
  type Generation,
  type LabelGenerationResult,
  type PreparationCheck,
  type PreparationCheckOutcome,
  type PreparationCheckResult,
} from "./generations.js";
import { RelayFacts, type RelayAttempt, type RelayFact } from "./relay-facts.js";
import {
  Recovery,
  type RecoveryEpisode,
  type RecoveryFailure,
  type RecoveryOperationReport,
  type RecoveryPolicy,
  type RepairOperationOutcome,
} from "./recovery.js";
import { FacetRelay } from "./relay.js";
import { mainFacetName } from "./facet-name.js";
import {
  checkGenerationStartup,
  type StartupCheckOptions,
  type StartupCheckResult,
} from "./startup-check.js";

type SupervisorEnv = {
  readonly LOADER: WorkerLoader;
};

export class Supervisor extends DurableObject<SupervisorEnv> {
  private readonly mainFacet:
    | { readonly fetcher: Fetcher }
    | { readonly problem: MainHarnessArtifactProblem };
  private readonly control: GenerationControl;
  private readonly generations: Generations;
  private readonly relayFacts: RelayFacts;
  private readonly recovery: Recovery;
  private readonly relay: FacetRelay;

  constructor(ctx: DurableObjectState, env: SupervisorEnv) {
    super(ctx, env);
    this.generations = new Generations(ctx.storage, fixtureMainHarnessCommit);
    this.control = new GenerationControl(ctx.storage, this.generations);
    this.relayFacts = new RelayFacts(ctx.storage);
    this.recovery = new Recovery(ctx.storage, this.generations, this.relayFacts);
    this.relay = new FacetRelay(this.relayFacts);
    const loadedFacet = loadFixtureMainFacet(env.LOADER);

    this.mainFacet = loadedFacet.ok
      ? {
          fetcher: ctx.facets.get(mainFacetName(fixtureMainHarnessCommit, "serving"), () => ({
            class: loadedFacet.facetClass,
          })),
        }
      : { problem: loadedFacet.problem };
  }

  labelGeneration(harnessCommit: string): LabelGenerationResult {
    return this.generations.label(harnessCommit);
  }

  recordPreparationCheck(label: number, outcome: PreparationCheckOutcome): PreparationCheckResult {
    return this.generations.recordPreparationCheck(label, outcome);
  }

  checkGenerationStartup(
    label: number,
    artifact: MainHarnessArtifactInput,
    options?: StartupCheckOptions,
  ): Promise<StartupCheckResult> {
    return checkGenerationStartup(
      this.ctx,
      this.env.LOADER,
      this.generations,
      label,
      artifact,
      options,
    );
  }

  activateGeneration(label: number): ActivationResult {
    return this.generations.activate(label);
  }

  getActiveGeneration(): ActiveGeneration {
    return this.generations.active();
  }

  getGeneration(label: number): Generation | undefined {
    return this.generations.byLabel(label);
  }

  getGenerations(): readonly Generation[] {
    return this.generations.all();
  }

  controlGeneration(request: GenerationRequest): GenerationControlResult {
    return this.control.execute(request);
  }

  getPreparationCheckHistory(label: number): readonly PreparationCheck[] {
    return this.generations.preparationCheckHistory(label);
  }

  getRelayAttempts(): readonly RelayAttempt[] {
    return this.relayFacts.attempts();
  }

  getRelayFacts(): readonly RelayFact[] {
    return this.relayFacts.facts();
  }

  sweepExpiredRelayAttempts(now: number): readonly RelayAttempt[] {
    return this.relayFacts.sweepExpired(now);
  }

  startRecovery(
    failure: RecoveryFailure,
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
    outcome: RepairOperationOutcome,
    now: number,
  ): RecoveryOperationReport {
    return this.recovery.reportOperation(id, key, outcome, now);
  }

  reconcileRecoveryOperation(
    id: number,
    key: string,
    outcome: RepairOperationOutcome,
    now: number,
  ): RecoveryOperationReport {
    return this.recovery.reconcileOperation(id, key, outcome, now);
  }

  getRecoveryEpisode(id: number): RecoveryEpisode | undefined {
    return this.recovery.get(id);
  }

  getGenerationEligibility(
    label: number,
    policy: EligibilityPolicy = DEFAULT_ELIGIBILITY_POLICY,
  ): GenerationEligibility {
    return deriveGenerationEligibility(
      {
        generationLabel: label,
        latestActivationId: this.generations.latestActivationId(label),
        latestPreparationCheck: this.generations.latestPreparationCheck(label),
        attempts: this.relayFacts.attempts(),
      },
      policy,
    );
  }

  override fetch(request: Request): Promise<Response> {
    const active = this.generations.active();
    const preparationCheckId = active.generation
      ? this.generations.latestPreparationCheck(active.generation.label)?.id
      : undefined;
    const attribution = { active, preparationCheckId };

    if ("problem" in this.mainFacet) {
      return Promise.resolve(this.relay.recordMountFailure(attribution));
    }

    return this.relay.forward(request, this.mainFacet.fetcher, attribution);
  }
}
