import { logEvent, type LogLevel, newRequestId, type RequestId } from "../diagnostics.js";
import { WORKSPACE_RPC_TIMEOUT_MS } from "../workspace-command-timeout.js";
import { routePattern } from "./route-pattern.js";
import { withRouteSpan } from "./route-span.js";

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

/**
 * Say that a successful response still reports a degraded state. The marked object must be the one
 * the route handler returns: a copy, such as a re-wrapped Response, loses the mark.
 */
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
 * Cloudflare Issues records `error` events and ignores `warn`, so the level decides whether an
 * operator sees a request. A request is an `error` when it faulted or when it ran at least as long
 * as one workspace call's budget. `degraded` and `refused` responses otherwise stay warnings: they
 * tell the owner something, and they did not hold the workspace.
 */
function settledLevel(outcome: ApplicationOutcome, durationMs: number): LogLevel {
  if (durationMs >= WORKSPACE_RPC_TIMEOUT_MS) return "error";

  return LEVEL[outcome];
}

/**
 * Run one owner API request. A request that reaches the workspace gets a fresh `requestId` and
 * writes one `route.settled` event when its response is ready. Other requests run quietly with no
 * id. A turn's response is a stream, so its event marks the headers; `turn.settled` is the end. If
 * the handler throws there is no response, so that event has `status` and `phase` `null`.
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
    const response = await withRouteSpan({ requestId, route: pattern }, () => run(requestId));
    const outcome = applicationOutcome(response);
    const durationMs = Date.now() - startedAt;

    logEvent(settledLevel(outcome, durationMs), "route.settled", {
      ...fields,
      status: response.status,
      applicationOutcome: outcome,
      durationMs,
      phase: route === STREAMED_ROUTE && response.status === 200 ? "headers" : "body",
    });

    return response;
  } catch (cause) {
    logEvent("error", "route.settled", {
      ...fields,
      status: null,
      applicationOutcome: "fault",
      durationMs: Date.now() - startedAt,
      phase: null,
    });

    throw cause;
  }
}
