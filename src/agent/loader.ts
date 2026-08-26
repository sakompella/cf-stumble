/// <reference types="@cloudflare/workers-types" />

export const healthyAgentSource = `
import { DurableObject } from "cloudflare:workers";

export class Agent extends DurableObject {
  fetch() {
    return new Response("pong");
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

export function loadAgent(
  loader: WorkerLoader,
  name: string,
  source: string,
): WorkerStub {
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
