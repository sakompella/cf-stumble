/// <reference types="@cloudflare/workers-types" />

import { isPlainObject, isString } from "./plain-values.js";
import { runGeneration0Turn } from "./turn.js";
import type { Generation0Capabilities } from "./capabilities.js";
import type { TurnProblem, TurnRequest } from "./turn.js";

/**
 * The startup-check response (ADR-0029). `GET /` is an ordinary request that must stay cheap and
 * deterministic: it reads no capability, so a passing check proves this generation's request
 * handling started rather than that a model or a workspace answered.
 */
const READY_BODY = "generation-0 main facet ready";

function problemStatus(problem: TurnProblem): number {
  switch (problem.code) {
    case "invalid-session-document":
      return 400;
    case "model-unavailable":
      return 502;
    case "invalid-model-request":
      return 500;
    default: {
      const exhaustive: never = problem.code;
      return exhaustive;
    }
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Boundary: the turn body is decoded JSON from the Supervisor's relay, so it has no proven shape here.
export function parseTurnRequest(value: unknown): TurnRequest | undefined {
  if (!isPlainObject(value)) return undefined;
  const { prompt, document } = value;
  if (!isString(prompt)) return undefined;
  if (document === null || document === undefined) return { prompt, document: null };
  return isString(document) ? { prompt, document } : undefined;
}

async function handleTurn(
  request: Request,
  capabilities: Generation0Capabilities,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: { code: "invalid-turn-request" } }, { status: 400 });
  }

  const parsed = parseTurnRequest(body);
  if (parsed === undefined) {
    return Response.json({ error: { code: "invalid-turn-request" } }, { status: 400 });
  }

  const outcome = await runGeneration0Turn(capabilities, parsed);
  return outcome.ok
    ? Response.json(outcome.result)
    : Response.json({ error: outcome.problem }, { status: problemStatus(outcome.problem) });
}

/**
 * The whole request surface of a Generation 0 facet: the startup check and one buffered turn. It
 * takes its capabilities as an argument, so the same handler serves the Durable Object facet and
 * an ordinary test.
 */
export function handleGeneration0Request(
  request: Request,
  capabilities: Generation0Capabilities,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/") {
    return Promise.resolve(new Response(READY_BODY));
  }
  if (path === "/turn") {
    return handleTurn(request, capabilities);
  }

  return Promise.resolve(new Response("Not found", { status: 404 }));
}
