/// <reference types="@cloudflare/workers-types" />

export const healthyAgentSource = `
import { DurableObject } from "cloudflare:workers";
import { connect } from "cloudflare:sockets";

export class Agent extends DurableObject {
  async fetch(request) {
    if (new URL(request.url).pathname === "/ping") {
      return new Response("pong");
    }

    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS spike_secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    const ownSecretRows = this.ctx.storage.sql.exec(
      "SELECT value FROM spike_secrets WHERE key = ?",
      "supervisor-secret",
    ).toArray();
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO spike_secrets (key, value) VALUES (?, ?)",
      "facet-marker",
      "facet-wrote-here",
    );

    let fetchOutcome = "blocked";
    try {
      await fetch("https://example.com/");
      fetchOutcome = "allowed";
    } catch {}

    let connectOutcome = "blocked";
    try {
      const socket = connect("example.com:443");
      await socket.opened;
      socket.close();
      connectOutcome = "allowed";
    } catch {}

    let supervisorRouteOutcome = "blocked";
    try {
      const response = await fetch("https://supervisor.internal/reset", {
        method: "POST",
      });
      supervisorRouteOutcome = response.ok ? "allowed" : "reachable";
    } catch {}

    return Response.json({
      message: "probe",
      ownSecret: ownSecretRows[0]?.value ?? null,
      ownRows: this.ctx.storage.sql.exec(
        "SELECT key, value FROM spike_secrets ORDER BY key",
      ).toArray(),
      envKeys: Object.keys(this.env).sort(),
      fetchOutcome,
      connectOutcome,
      supervisorRouteOutcome,
    });
  }
}
`;

export const syntaxErrorAgentSource = `
import { DurableObject } from "cloudflare:workers";

export class Agent extends DurableObject {
  fetch() {
    return new Response("pong");
  }
// missing closing brace
`;

export const initializationErrorAgentSource = `
import { DurableObject } from "cloudflare:workers";

export class Agent extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    throw new Error("candidate initialization failed");
  }

  fetch() {
    return new Response("pong");
  }
}
`;

export function loadAgent(loader: WorkerLoader, name: string, source: string): WorkerStub {
  return loader.get(name, () => ({
    compatibilityDate: "2025-01-01",
    mainModule: "agent.js",
    modules: {
      "agent.js": { js: source },
    },
    env: {},
    globalOutbound: null,
  }));
}
