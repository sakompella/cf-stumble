import { logEvent, logRedactedCause, timed, type RequestId } from "../diagnostics.js";
import type { ActiveGeneration } from "../supervisor/generations/index.js";
import type { VerifiedAccessScope } from "../supervisor/projects/index.js";
import type { ProjectThreadResult } from "../supervisor/threads/index.js";
import {
  handleGenerationControl,
  handleGenerationSubmission,
  type GenerationControlSupervisor,
  type GenerationSubmissionSupervisor,
} from "./generations.js";
import { jsonError } from "./json.js";
import { projectIdFromPath, routePattern } from "./route-pattern.js";
import { settleRoute } from "./route-settled.js";
import { routeProjectApiRequest, type ProjectApiSupervisor } from "./projects.js";
import { routeProjectTurnRequest, type TurnApiSupervisor } from "./turns.js";

type WorkspaceResetResult = Readonly<{
  ok: true;
  reset: "workspace";
}>;

export type OwnerApiSupervisor = GenerationControlSupervisor &
  GenerationSubmissionSupervisor &
  ProjectApiSupervisor &
  TurnApiSupervisor & {
    readonly getActiveGeneration: () => Promise<ActiveGeneration>;
    readonly getProjectThread: (projectId: string) => Promise<ProjectThreadResult>;
    readonly startFreshProjectThread: (projectId: string) => Promise<ProjectThreadResult>;
    readonly resetWorkspace: () => Promise<WorkspaceResetResult>;
  };

async function workspaceResetResponse(supervisor: OwnerApiSupervisor): Promise<Response> {
  return Response.json(
    await timed(
      "workspace.reset",
      {},
      () => supervisor.resetWorkspace(),
      () => ({
        outcome: "reset",
      }),
    ),
  );
}

/** The active generation and the epoch a control request must observe. */
/**
 * `generation` and `activationId` are written out as `null` when there is none, rather than left
 * off. `Response.json` drops an undefined field, so an instance with nothing active answered
 * `{"activeGeneration":{"epoch":0}}`, which reads like an active generation at epoch 0 to anyone
 * who has not read this file. The epoch is the control epoch and legitimately starts at 0.
 */
async function statusResponse(supervisor: OwnerApiSupervisor): Promise<Response> {
  const active = await supervisor.getActiveGeneration();

  return Response.json({
    activeGeneration: {
      generation: active.generation ?? null,
      epoch: active.epoch,
      activationId: active.activationId ?? null,
    },
  });
}

async function threadResponse(
  read: () => Promise<ProjectThreadResult>,
  // Naming a project the catalog does not have is a 404, because the client asked for something
  // that does not exist. Anything else is a fault about the thread it did name.
): Promise<Response> {
  const result = await read();

  if (result.ok) {
    return Response.json({ ok: true, thread: result.thread });
  }

  const status = result.problem.code === "unreadable-thread" ? 500 : 404;

  return Response.json({ ok: false, problem: result.problem }, { status });
}

/**
 * The Worker calls this only after it verifies Cloudflare Access and derives the Supervisor name.
 * Request data selects only one of the tenant's projects, a generation label, and an epoch within
 * that already-selected Supervisor. It never names a tenant, an identity, or a Durable Object.
 *
 * The verified scope arrives as an argument, from the boundary that proved it. It is the same
 * scope the Supervisor's name was derived from (`access/index.ts`), so the project routes bind an
 * authorization to an owner without deriving a second opinion of who that owner is.
 */
export function routeOwnerApiRequest(
  request: Request,
  supervisor: OwnerApiSupervisor,
  scope: VerifiedAccessScope,
): Promise<Response> {
  return settleRoute(request, (requestId) =>
    dispatchOwnerApiRequest(request, supervisor, scope, requestId),
  );
}

/**
 * The owner API treats every `POST` as a state change, so each one has to come from cf-stumble's
 * own page.
 *
 * Access sits in front of everything here, so a cross-site request cannot be a stranger's; it can
 * still be the owner's own browser driven by another site, which is what would let a page the
 * owner happens to visit start an authorization or connect a repository in their name. The
 * browser must send an `Origin` that exactly matches the request URL's origin. A missing value,
 * `null`, and every other value are refused.
 *
 * The refusal is logged here: the route pattern and which kind of origin it was, never the origin
 * itself.
 */
function isCrossOriginMutation(request: Request): boolean {
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  const crossOrigin = origin === null || origin !== url.origin;

  if (crossOrigin) {
    logEvent("warn", "route.cross-origin-refused", {
      route: routePattern(url.pathname),
      method: request.method,
      origin: origin === null ? "missing" : origin === "null" ? "null" : "foreign",
    });
  }

  return crossOrigin;
}

/**
 * A thrown Supervisor error is logged, redacted, and answered with a bare 500, because its text can
 * come from a generation's code or a workspace command and is not this boundary's to hand out.
 */
async function dispatchOwnerApiRequest(
  request: Request,
  supervisor: OwnerApiSupervisor,
  scope: VerifiedAccessScope,
  requestId: RequestId | undefined,
): Promise<Response> {
  if (request.method === "POST" && isCrossOriginMutation(request)) {
    return jsonError(403, "cross-origin-request");
  }

  try {
    return await ownerApiRoute(request, supervisor, scope, requestId);
  } catch (cause) {
    const route = routePattern(new URL(request.url).pathname);
    logRedactedCause(`owner-api ${request.method} ${route}: internal-error`, cause);

    return jsonError(500, "internal-error");
  }
}

function ownerApiRoute(
  request: Request,
  supervisor: OwnerApiSupervisor,
  scope: VerifiedAccessScope,
  requestId: RequestId | undefined,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const projectRoute = routeProjectApiRequest(request, supervisor, scope, requestId);

  if (projectRoute !== undefined) {
    return projectRoute;
  }

  const turnRoute = routeProjectTurnRequest(request, supervisor);

  if (turnRoute !== undefined) {
    return turnRoute;
  }

  const isGet = request.method === "GET";
  const isPost = request.method === "POST";

  if (isGet && pathname === "/api/status") {
    return statusResponse(supervisor);
  }

  if (isPost && pathname === "/api/generations/submit") {
    return handleGenerationSubmission(request, supervisor);
  }

  if (isPost && pathname === "/api/generations/activate") {
    return handleGenerationControl(request, supervisor, "activate");
  }

  if (isPost && pathname === "/api/generations/rollback") {
    return handleGenerationControl(request, supervisor, "rollback");
  }

  if (isPost && pathname === "/api/workspace/reset") {
    return workspaceResetResponse(supervisor);
  }

  const threadProjectId = projectIdFromPath(pathname, "/thread");

  if (isGet && threadProjectId !== undefined) {
    return threadResponse(() => supervisor.getProjectThread(threadProjectId));
  }

  const freshProjectId = projectIdFromPath(pathname, "/thread/fresh");

  if (isPost && freshProjectId !== undefined) {
    return threadResponse(() => supervisor.startFreshProjectThread(freshProjectId));
  }

  return Promise.resolve(jsonError(404, "not-found"));
}
