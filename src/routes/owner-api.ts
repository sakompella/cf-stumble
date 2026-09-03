// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns -- Request JSON is parsed and validated at this HTTP boundary.
import type { ActiveGeneration } from "../supervisor/generations/index.js";
import type { SessionRecord, SessionTurnResult } from "../supervisor/sessions/index.js";
import { handleGenerationControl, type GenerationControlSupervisor } from "./generations.js";
import { hasExactKeys, isCount, isRecord, jsonError, readJson } from "./json.js";
import { latestRecoveryReportSummary, type RecoveryReportSupervisor } from "./recovery.js";

export type OwnerApiSupervisor = GenerationControlSupervisor &
  RecoveryReportSupervisor & {
    readonly getActiveGeneration: () => Promise<ActiveGeneration>;
    readonly getSession: (sessionId: string) => Promise<SessionRecord | undefined>;
    readonly runSessionTurn: (
      sessionId: string,
      prompt: string,
      expectedRevision: number,
    ) => Promise<SessionTurnResult>;
  };

type TurnRequest = {
  readonly prompt: string;
  readonly expectedRevision: number;
};

function parseTurnRequest(value: unknown): TurnRequest | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["expectedRevision", "prompt"])) {
    return undefined;
  }
  const { prompt, expectedRevision } = value;
  if (typeof prompt !== "string" || !isCount(expectedRevision)) {
    return undefined;
  }
  return { prompt, expectedRevision };
}

function sessionRoute(
  pathname: string,
): { readonly sessionId: string; readonly isTurn: boolean } | undefined {
  const matched = /^\/api\/sessions\/([^/]+)(\/turn)?$/u.exec(pathname);
  if (matched === null) {
    return undefined;
  }
  const encodedSessionId = matched[1];
  if (encodedSessionId === undefined) {
    return undefined;
  }
  try {
    const sessionId = decodeURIComponent(encodedSessionId);
    return sessionId.length === 0 ? undefined : { sessionId, isTurn: matched[2] === "/turn" };
  } catch {
    return undefined;
  }
}

function notFound(): Promise<Response> {
  return Promise.resolve(jsonError(404, "not-found"));
}

/** The active generation, the epoch a control request must observe, and the last recovery report. */
async function statusResponse(supervisor: OwnerApiSupervisor): Promise<Response> {
  try {
    const [activeGeneration, latestRecoveryReport] = await Promise.all([
      supervisor.getActiveGeneration(),
      latestRecoveryReportSummary(supervisor),
    ]);
    return Response.json({ activeGeneration, latestRecoveryReport });
  } catch {
    return jsonError(500, "internal-error");
  }
}

async function recoveryResponse(supervisor: OwnerApiSupervisor): Promise<Response> {
  try {
    return Response.json({ ok: true, report: await latestRecoveryReportSummary(supervisor) });
  } catch {
    return jsonError(500, "internal-error");
  }
}

async function sessionResponse(
  supervisor: OwnerApiSupervisor,
  sessionId: string,
): Promise<Response> {
  try {
    const record = await supervisor.getSession(sessionId);
    return record === undefined
      ? jsonError(404, "session-not-found")
      : Response.json({ ok: true, session: record });
  } catch {
    return jsonError(500, "internal-error");
  }
}

async function turnResponse(
  request: Request,
  supervisor: OwnerApiSupervisor,
  sessionId: string,
): Promise<Response> {
  const body = parseTurnRequest(await readJson(request));
  if (body === undefined) {
    return jsonError(400, "invalid-turn-request");
  }
  try {
    return Response.json(
      await supervisor.runSessionTurn(sessionId, body.prompt, body.expectedRevision),
    );
  } catch {
    return jsonError(500, "internal-error");
  }
}

/**
 * The Worker calls this only after it verifies Cloudflare Access and derives the Supervisor name.
 * Request data selects only an opaque session, a generation label, and an epoch within that
 * already-selected Supervisor. It never names a tenant, an identity, or a Durable Object.
 */
export function routeOwnerApiRequest(
  request: Request,
  supervisor: OwnerApiSupervisor,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const isGet = request.method === "GET";
  const isPost = request.method === "POST";

  if (isGet && pathname === "/api/status") {
    return statusResponse(supervisor);
  }
  if (isGet && pathname === "/api/recovery/latest") {
    return recoveryResponse(supervisor);
  }
  if (isPost && pathname === "/api/generations/activate") {
    return handleGenerationControl(request, supervisor, "activate");
  }
  if (isPost && pathname === "/api/generations/rollback") {
    return handleGenerationControl(request, supervisor, "rollback");
  }

  const session = sessionRoute(pathname);
  if (session === undefined) {
    return notFound();
  }
  if (isGet && !session.isTurn) {
    return sessionResponse(supervisor, session.sessionId);
  }
  if (isPost && session.isTurn) {
    return turnResponse(request, supervisor, session.sessionId);
  }

  return notFound();
}
