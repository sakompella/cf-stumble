/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import { loadFixtureMainFacet } from "../agent/loader.js";

type SupervisorEnv = {
  readonly LOADER: WorkerLoader;
};

export class Supervisor extends DurableObject<SupervisorEnv> {
  private readonly mainFacet: Fetcher;

  constructor(ctx: DurableObjectState, env: SupervisorEnv) {
    super(ctx, env);
    this.mainFacet = ctx.facets.get("main-facet-fixture", () => ({
      class: loadFixtureMainFacet(env.LOADER),
    }));
  }

  override fetch(request: Request): Promise<Response> {
    return this.mainFacet.fetch(request);
  }
}
