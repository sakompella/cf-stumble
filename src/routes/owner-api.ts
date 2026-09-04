// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns -- Request JSON is parsed and validated at this HTTP boundary.
import type { ActiveGeneration } from "../supervisor/generations/index.js";
import type { ProjectThreadResult } from "../supervisor/threads/index.js";
import {
  handleGenerationControl,
  handleGenerationSubmission,
  type GenerationControlSupervisor,
  type GenerationSubmissionSupervisor,
} from "./generations.js";
import { jsonError } from "./json.js";
import { latestRecoveryReportSummary, type RecoveryReportSupervisor } from "./recovery.js";

export type OwnerApiSupervisor = GenerationControlSupervisor &
  GenerationSubmissionSupervisor &
  RecoveryReportSupervisor & {
    readonly getActiveGeneration: () => Promise<ActiveGeneration>;
    readonly getProjectThread: (projectId: string) => Promise<ProjectThreadResult>;
    readonly startFreshProjectThread: (projectId: string) => Promise<ProjectThreadResult>;
  };

/**
 * The project id a client named, still a plain string. The Supervisor resolves it against the
 * catalog; this route only takes it out of the path, so an id the catalog does not know reaches
 * the Supervisor and comes back as `unknown-project-id` rather than being guessed at here.
 */
function threadRoute(
  pathname: string,
): { readonly projectId: string; readonly isReset: boolean } | undefined {
  const matched = /^\/api\/projects\/([^/]+)\/thread(\/fresh)?$/u.exec(pathname);
  const encodedProjectId = matched?.[1];
  if (encodedProjectId === undefined) {
    return undefined;
  }
  try {
    const projectId = decodeURIComponent(encodedProjectId);
    return projectId.length === 0 ? undefined : { projectId, isReset: matched?.[2] === "/fresh" };
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

async function threadResponse(
  read: () => Promise<ProjectThreadResult>,
  // Naming a project the catalog does not have is a 404, because the client asked for something
  // that does not exist. Anything else is a fault about the thread it did name.
): Promise<Response> {
  try {
    const result = await read();
    if (result.ok) {
      return Response.json({ ok: true, thread: result.thread });
    }
    const status = result.problem.code === "unreadable-thread" ? 500 : 404;
    return Response.json({ ok: false, problem: result.problem }, { status });
  } catch {
    return jsonError(500, "internal-error");
  }
}

/**
 * The Worker calls this only after it verifies Cloudflare Access and derives the Supervisor name.
 * Request data selects only one of the tenant's projects, a generation label, and an epoch within
 * that already-selected Supervisor. It never names a tenant, an identity, or a Durable Object.
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
  if (isPost && pathname === "/api/generations/submit") {
    return handleGenerationSubmission(request, supervisor);
  }
  if (isPost && pathname === "/api/generations/activate") {
    return handleGenerationControl(request, supervisor, "activate");
  }
  if (isPost && pathname === "/api/generations/rollback") {
    return handleGenerationControl(request, supervisor, "rollback");
  }

  const thread = threadRoute(pathname);
  if (thread === undefined) {
    return notFound();
  }
  if (isGet && !thread.isReset) {
    return threadResponse(() => supervisor.getProjectThread(thread.projectId));
  }
  if (isPost && thread.isReset) {
    return threadResponse(() => supervisor.startFreshProjectThread(thread.projectId));
  }

  return notFound();
}
