/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import { fixtureMainHarnessCommit, loadFixtureMainFacet } from "../agent/loader.js";
import type { MainHarnessArtifactInput, MainHarnessArtifactProblem } from "../agent/loader.js";
import { GenerationControl } from "./control.js";
import { DEFAULT_ELIGIBILITY_POLICY, deriveGenerationEligibility } from "./eligibility.js";
import type { EligibilityPolicy, GenerationEligibility } from "./eligibility.js";
import { Generations } from "./generations.js";
import { RelayFacts } from "./relay-facts.js";
import type { RelayAttempt, RelayFact } from "./relay-facts.js";
import { FacetRelay } from "./relay.js";
import { mainFacetName } from "./facet-name.js";
import { checkGenerationStartup } from "./startup-check.js";
import type { StartupCheckOptions, StartupCheckResult } from "./startup-check.js";
import type {
  ActivationResult,
  ActiveGeneration,
  Generation,
  LabelGenerationResult,
  PreparationCheckOutcome,
  PreparationCheckResult,
} from "./generations.js";
import type { GenerationControlResult, GenerationRequest } from "./control.js";
import type { PreparationCheck } from "./preparation-checks.js";

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
  private readonly relay: FacetRelay;

  constructor(ctx: DurableObjectState, env: SupervisorEnv) {
    super(ctx, env);
    this.generations = new Generations(ctx.storage, fixtureMainHarnessCommit);
    this.control = new GenerationControl(ctx.storage, this.generations);
    this.relayFacts = new RelayFacts(ctx.storage);
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

  getGenerationEligibility(
    label: number,
    policy: EligibilityPolicy = DEFAULT_ELIGIBILITY_POLICY,
  ): GenerationEligibility {
    return deriveGenerationEligibility(
      {
        generationLabel: label,
        active: this.generations.active(),
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
