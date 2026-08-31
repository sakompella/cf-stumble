/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import { parseHarnessCommit } from "../harness-commit.js";
import {
  fixtureMainHarnessArtifact,
  fixtureMainHarnessCommit,
  loadMainFacet,
  type MainHarnessArtifactInput,
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
  parseGenerationLabel,
  type ActiveGeneration,
  type Generation,
  type PreparationCheck,
} from "./generations.js";
import { RelayAttempts, type RelayAttempt } from "./relay-attempts.js";
import {
  Recovery,
  type RecoveryEpisode,
  type RecoveryFailureInput,
  type RecoveryOperationReport,
  type RecoveryOperationOutcomeInput,
  type RecoveryPolicy,
} from "./recovery.js";
import { FacetRelay } from "./relay.js";
import { mainFacetName } from "./facet-name.js";
import { HarnessArtifacts } from "./harness-artifacts.js";
import {
  checkGenerationStartup,
  type StartupCheckOptions,
  type StartupCheckResult,
} from "./startup-check.js";

type SupervisorEnv = {
  readonly LOADER: WorkerLoader;
};

export class Supervisor extends DurableObject<SupervisorEnv> {
  private readonly control: GenerationControl;
  private readonly generations: Generations;
  private readonly artifacts: HarnessArtifacts;
  private readonly relayAttempts: RelayAttempts;
  private readonly recovery: Recovery;
  private readonly relay: FacetRelay;

  constructor(ctx: DurableObjectState, env: SupervisorEnv) {
    super(ctx, env);
    this.generations = new Generations(ctx.storage, fixtureMainHarnessCommit);
    this.artifacts = new HarnessArtifacts(ctx.storage, fixtureMainHarnessArtifact);
    this.control = new GenerationControl(ctx.storage, this.generations);
    this.relayAttempts = new RelayAttempts(ctx.storage);
    this.recovery = new Recovery(ctx.storage, this.generations, this.relayAttempts);
    this.relay = new FacetRelay(this.relayAttempts);
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

  override fetch(request: Request): Promise<Response> {
    const active = this.generations.active();
    const preparationCheckId = active.generation
      ? this.generations.latestPreparationCheck(active.generation.label)?.id
      : undefined;
    const attribution = { active, preparationCheckId };
    const mainFacet = this.mountActiveFacet(active);

    if ("problem" in mainFacet) {
      return Promise.resolve(this.relay.recordMountFailure(attribution));
    }

    return this.relay.forward(request, mainFacet.fetcher, attribution);
  }

  private mountActiveFacet(
    active: ActiveGeneration,
  ): { readonly fetcher: Fetcher } | { readonly problem: string } {
    const fixtureCommit = parseHarnessCommit(fixtureMainHarnessCommit);
    const harnessCommit = active.generation?.harnessCommit ?? fixtureCommit;
    if (harnessCommit === undefined) {
      return { problem: "fixture harness commit is invalid" };
    }

    const retainedArtifact = this.artifacts.get(harnessCommit);
    if (!retainedArtifact.ok || retainedArtifact.artifact === undefined) {
      return {
        problem: retainedArtifact.ok
          ? "retained artifact was not found"
          : retainedArtifact.problem.code,
      };
    }

    const loadedFacet = loadMainFacet(this.env.LOADER, retainedArtifact.artifact);
    if (!loadedFacet.ok) {
      return { problem: loadedFacet.problem.code };
    }

    return {
      fetcher: this.ctx.facets.get(mainFacetName(harnessCommit, "serving"), () => ({
        class: loadedFacet.facetClass,
      })),
    };
  }
}
