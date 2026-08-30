/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import { fixtureMainHarnessCommit, loadFixtureMainFacet } from "../agent/loader.js";
import type { MainHarnessArtifactProblem } from "../agent/loader.js";
import { Generations } from "./generations.js";
import type {
  ActivationResult,
  ActiveGeneration,
  Generation,
  LabelGenerationResult,
  PreparationCheckOutcome,
  PreparationCheckResult,
} from "./generations.js";

type SupervisorEnv = {
  readonly LOADER: WorkerLoader;
};

export class Supervisor extends DurableObject<SupervisorEnv> {
  private readonly mainFacet:
    | { readonly fetcher: Fetcher }
    | { readonly problem: MainHarnessArtifactProblem };
  private readonly generations: Generations;

  constructor(ctx: DurableObjectState, env: SupervisorEnv) {
    super(ctx, env);
    this.generations = new Generations(ctx.storage, fixtureMainHarnessCommit);
    const loadedFacet = loadFixtureMainFacet(env.LOADER);

    this.mainFacet = loadedFacet.ok
      ? {
          fetcher: ctx.facets.get("main-facet-fixture", () => ({
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

  override fetch(request: Request): Promise<Response> {
    if ("problem" in this.mainFacet) {
      return Promise.resolve(
        new Response(`Cannot mount main facet: ${this.mainFacet.problem.code}`, { status: 500 }),
      );
    }

    return this.mainFacet.fetcher.fetch(request);
  }
}
