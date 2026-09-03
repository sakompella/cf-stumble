// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns -- Request JSON is parsed and validated at this HTTP boundary.
import type { ActiveGeneration } from "../supervisor/generations/index.js";
import type { SessionRecord, SessionTurnResult } from "../supervisor/sessions/index.js";

export type OwnerApiSupervisor = {
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

type ApiErrorCode = "invalid-turn-request" | "not-found" | "session-not-found" | "internal-error";

function jsonError(status: number, code: ApiErrorCode): Response {
  return Response.json({ ok: false, error: { code } }, { status });
}

function parseTurnRequest(value: unknown): TurnRequest | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["expectedRevision", "prompt"])) {
    return undefined;
  }
  const { prompt, expectedRevision } = value;
  if (
    typeof prompt !== "string" ||
    typeof expectedRevision !== "number" ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    return undefined;
  }
  return { prompt, expectedRevision };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).toSorted();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
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

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/**
 * The Worker calls this only after it verifies Cloudflare Access and derives the Supervisor name.
 * Request data selects only an opaque session within that already-selected Supervisor.
 */
export async function routeOwnerApiRequest(
  request: Request,
  supervisor: OwnerApiSupervisor,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (request.method === "GET" && pathname === "/api/status") {
    try {
      const activeGeneration = await supervisor.getActiveGeneration();
      return Response.json({ activeGeneration, latestRecoveryReport: null });
    } catch {
      return jsonError(500, "internal-error");
    }
  }

  const session = sessionRoute(pathname);
  if (session === undefined) {
    return jsonError(404, "not-found");
  }

  if (request.method === "GET" && !session.isTurn) {
    try {
      const record = await supervisor.getSession(session.sessionId);
      return record === undefined
        ? jsonError(404, "session-not-found")
        : Response.json({ ok: true, session: record });
    } catch {
      return jsonError(500, "internal-error");
    }
  }

  if (request.method === "POST" && session.isTurn) {
    const body = parseTurnRequest(await readJson(request));
    if (body === undefined) {
      return jsonError(400, "invalid-turn-request");
    }
    try {
      return Response.json(
        await supervisor.runSessionTurn(session.sessionId, body.prompt, body.expectedRevision),
      );
    } catch {
      return jsonError(500, "internal-error");
    }
  }

  return jsonError(404, "not-found");
}
