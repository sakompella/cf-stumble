import { logEvent, type LogLevel } from "../diagnostics.js";
import { newRequestId, type RequestId } from "../request-id.js";
import { routePattern } from "./route-pattern.js";

/**
 * How the application judged a request, apart from its HTTP status: `degraded` is a success
 * status that still tells the owner something is wrong, such as a GitHub connection that needs to
 * be reconnected.
 */
export type ApplicationOutcome = "ok" | "degraded" | "refused" | "fault";

/** Owner API routes that reach the workspace, by method and route pattern. */
const WORKSPACE_ROUTES: ReadonlySet<string> = new Set([
  "GET /api/projects",
  "GET /api/github/connection",
  "POST /api/github/authorization",
  "POST /api/github/authorization/complete",
  "POST /api/projects/connect",
  "POST /api/projects/:projectId/disconnect",
  "POST /api/projects/:projectId/turn",
  "POST /api/generations/submit",
  "POST /api/workspace/reset",
]);

const STREAMED_ROUTE = "POST /api/projects/:projectId/turn";

const degradedResponses = new WeakSet<Response>();

/** Say that a successful response still reports a degraded state. */
export function markDegraded(response: Response): Response {
  degradedResponses.add(response);

  return response;
}

function applicationOutcome(response: Response): ApplicationOutcome {
  if (response.status >= 500) return "fault";

  if (response.status >= 400) return "refused";

  return degradedResponses.has(response) ? "degraded" : "ok";
}

const LEVEL = {
  ok: "info",
  degraded: "warn",
  refused: "warn",
  fault: "error",
} as const satisfies Record<ApplicationOutcome, LogLevel>;

/**
 * A client that left is known only when the runtime aborts the request signal, which needs the
 * `enable_request_signal` compatibility flag. A live signal therefore proves nothing, so the log
 * says `true` or `null`, never `false`.
 */
function clientAborted(request: Request): true | null {
  return signalAborted(request.signal) ? true : null;
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Run one owner API request. A request that reaches the workspace gets a fresh `requestId` and
 * writes one `route.settled` event when its response is ready. Other requests run quietly with no
 * id. A turn's response is a stream, so its event marks the headers; `turn.settled` is the end.
 */
export async function settleRoute(
  request: Request,
  run: (requestId?: RequestId) => Promise<Response>,
): Promise<Response> {
  const pattern = routePattern(new URL(request.url).pathname);
  const route = `${request.method} ${pattern}`;

  if (!WORKSPACE_ROUTES.has(route)) return run();

  const requestId = newRequestId();
  const startedAt = Date.now();
  const fields = { requestId, route: pattern, method: request.method } as const;

  try {
    const response = await run(requestId);
    const outcome = applicationOutcome(response);
    const aborted = clientAborted(request);

    logEvent(aborted === true && outcome === "ok" ? "warn" : LEVEL[outcome], "route.settled", {
      ...fields,
      status: response.status,
      applicationOutcome: outcome,
      durationMs: Date.now() - startedAt,
      clientAborted: aborted,
      phase: route === STREAMED_ROUTE && response.status === 200 ? "headers" : "body",
    });

    return response;
  } catch (cause) {
    logEvent("error", "route.settled", {
      ...fields,
      status: null,
      applicationOutcome: "fault",
      durationMs: Date.now() - startedAt,
      clientAborted: clientAborted(request),
      phase: "headers",
    });

    throw cause;
  }
}
