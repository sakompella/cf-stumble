/// <reference types="@cloudflare/workers-types" />

import {
  healthyAgentSource,
  initializationErrorAgentSource,
  loadAgent,
  syntaxErrorAgentSource,
} from "../agent/loader.js";
import { DurableObject } from "cloudflare:workers";

type SupervisorEnv = {
  readonly LOADER: WorkerLoader;
};

type CandidateMode = "healthy" | "syntax" | "init";

const initialCandidate: CandidateMode = "healthy";
const secretKey = "supervisor-secret";

export class Supervisor extends DurableObject<SupervisorEnv> {
  private attempt = 0;
  private activeFacetName: string | undefined;

  constructor(ctx: DurableObjectState, env: SupervisorEnv) {
    super(ctx, env);

    void ctx.blockConcurrencyWhile(() => {
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS spike_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS spike_secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      const candidate = this.readState("candidate");
      if (candidate === undefined) {
        this.writeState("candidate", initialCandidate);
      }
      if (this.readState("generation") === undefined) {
        this.writeState("generation", "0");
      }
      return Promise.resolve();
    });
  }

  override fetch(request: Request): Response | Promise<Response> {
    const { pathname } = new URL(request.url);

    switch (pathname) {
      case "/facet/ping":
        return this.fetchFacet("ping");
      case "/facet/probe":
        return this.fetchFacet("probe");
      case "/seed":
        return this.seed();
      case "/inspect":
        return this.inspect();
      case "/state":
        return this.state();
      case "/promote":
        return this.promote();
      case "/reset":
        return this.reset();
      case "/candidate/healthy":
        return this.setCandidate("healthy");
      case "/candidate/syntax":
        return this.setCandidate("syntax");
      case "/candidate/init":
        return this.setCandidate("init");
      default:
        return new Response("not found", { status: 404 });
    }
  }

  private fetchFacet(path: "ping" | "probe"): Promise<Response> {
    const facet = this.mountFacet(this.readCandidateSource());
    return facet.fetch(new Request(`https://facet/${path}`));
  }

  private mountFacet(source: string): Fetcher {
    this.attempt += 1;
    const uniqueName = `${this.attempt}-${crypto.randomUUID()}`;
    const worker = loadAgent(this.env.LOADER, `candidate-${uniqueName}`, source);
    const facetName = `agent-${uniqueName}`;
    const agentClass = worker.getDurableObjectClass("Agent");
    const facet = this.ctx.facets.get(facetName, () => ({ class: agentClass }));
    this.activeFacetName = facetName;
    return facet;
  }

  private seed(): Response {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO spike_secrets (key, value) VALUES (?, ?)",
      secretKey,
      "supervisor-only-secret",
    );
    this.writeState("generation", "0");
    return new Response("seeded", { status: 201 });
  }

  private inspect(): Response {
    const rows = this.ctx.storage.sql
      .exec<{ key: string; value: string }>(
        "SELECT key, value FROM spike_secrets ORDER BY key",
      )
      .toArray();
    return Response.json({ rows });
  }

  private state(): Response {
    return Response.json({
      candidate: this.readState("candidate"),
      generation: this.readState("generation"),
    });
  }

  private async promote(): Promise<Response> {
    try {
      const facet = this.mountFacet(this.readCandidateSource());
      const response = await facet.fetch(new Request("https://facet/probe"));
      if (!response.ok) {
        return Response.json(
          { promoted: false, reason: `facet returned ${response.status}` },
          { status: 422 },
        );
      }
      this.writeState("generation", "candidate");
      return Response.json({ promoted: true });
    } catch (error: unknown) {
      return Response.json(
        { promoted: false, reason: errorMessage(error) },
        { status: 422 },
      );
    }
  }

  private reset(): Response {
    if (this.activeFacetName !== undefined) {
      this.ctx.facets.delete(this.activeFacetName);
    }
    this.writeState("generation", "0");
    return Response.json({ generation: "0", reset: true });
  }

  private setCandidate(mode: CandidateMode): Response {
    this.writeState("candidate", mode);
    return Response.json({ candidate: mode });
  }

  private readCandidateSource(): string {
    const candidate = this.readState("candidate");
    if (candidate === "syntax") {
      return syntaxErrorAgentSource;
    }
    if (candidate === "init") {
      return initializationErrorAgentSource;
    }
    return healthyAgentSource;
  }

  private readState(key: string): string | undefined {
    const rows = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM spike_state WHERE key = ?", key)
      .toArray();
    return rows[0]?.value;
  }

  private writeState(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO spike_state (key, value) VALUES (?, ?)",
      key,
      value,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
