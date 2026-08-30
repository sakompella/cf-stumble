/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import { loadFixtureMainFacet } from "../agent/loader.js";
import type { MainHarnessArtifactProblem } from "../agent/loader.js";

type SupervisorEnv = {
  readonly LOADER: WorkerLoader;
};

export class Supervisor extends DurableObject<SupervisorEnv> {
  private readonly mainFacet:
    | { readonly fetcher: Fetcher }
    | { readonly problem: MainHarnessArtifactProblem };

  constructor(ctx: DurableObjectState, env: SupervisorEnv) {
    super(ctx, env);
    const loadedFacet = loadFixtureMainFacet(env.LOADER);

    this.mainFacet = loadedFacet.ok
      ? {
          fetcher: ctx.facets.get("main-facet-fixture", () => ({
            class: loadedFacet.facetClass,
          })),
        }
      : { problem: loadedFacet.problem };
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
