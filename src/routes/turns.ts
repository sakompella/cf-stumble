// oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- Request JSON is parsed and validated at this HTTP boundary.
import { hasExactKeys, isRecord, jsonError, readJson } from "./json.js";
import { isCrossOriginMutation } from "./projects.js";
import type { ProjectTurnRun, ProjectTurnRunProblemCode } from "../supervisor/projects/index.js";

/**
 * The one entry a browser has to the coding half of cf-stumble: `POST /api/projects/{id}/turn`.
 *
 * The body carries a prompt and nothing else. A tenant, a conversation, a model, a lease, and a
 * generation are all things the Supervisor holds; there is no field here through which one could
 * arrive, so this route cannot be talked into running a turn on someone else's thread. The
 * response is the turn as it happens: newline-delimited frames the Supervisor proved, ending in
 * the one terminal frame it wrote after deciding what was saved.
 */
export type TurnApiSupervisor = Readonly<{
  runProjectTurn: (projectId: unknown, prompt: unknown) => Promise<ProjectTurnRun>;
}>;

/**
 * What each refusal is, as an HTTP fact. A conflict is the project already running a turn or its
 * thread having moved on; unavailable is the Supervisor having nothing to run the turn with, which
 * is not the client's fault and not a permanent answer. `unreadable-thread` is the Supervisor's
 * own damaged row, so it is the only one that is a fault of this service.
 *
 * The table is total over every code the thread surface and the turn path can produce, including
 * the lease codes only a running turn reaches today. That is deliberate: the compiler fails this
 * file when a new code appears, which is safer than a default status that would answer a fault
 * nobody chose an answer for.
 */
const TURN_STATUS = {
  "invalid-project-id": 400,
  "invalid-prompt": 400,
  "invalid-messages": 400,
  "unknown-project-id": 404,
  "turn-conflict": 409,
  "stale-revision": 409,
  "turn-not-active": 409,
  "turn-expired": 409,
  "turn-lease-lost": 409,
  "unreadable-thread": 500,
  "no-active-generation": 503,
  "mount-failed": 503,
  "workspace-unavailable": 503,
  "turn-not-started": 503,
} as const satisfies Record<ProjectTurnRunProblemCode, number>;

/** The project id a client named, still a plain string. The Supervisor resolves it. */
function turnRoute(pathname: string): string | undefined {
  const encodedProjectId = /^\/api\/projects\/([^/]+)\/turn$/u.exec(pathname)?.[1];
  if (encodedProjectId === undefined) {
    return undefined;
  }
  try {
    const projectId = decodeURIComponent(encodedProjectId);
    return projectId.length === 0 ? undefined : projectId;
  } catch {
    return undefined;
  }
}

function turnPrompt(value: unknown): string | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["prompt"]) || typeof value.prompt !== "string") {
    return undefined;
  }
  return value.prompt;
}

/**
 * The frames, as a response the browser can read while the turn runs.
 *
 * `no-store` because a turn is not a document, and `nosniff` because a stream of JSON lines must
 * not be sampled into some other content type. Cancelling this body is what tells the Supervisor
 * the browser is gone, so nothing here buffers it.
 */
function turnStreamResponse(frames: ReadableStream<Uint8Array>): Response {
  return new Response(frames, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function turnResponse(
  request: Request,
  supervisor: TurnApiSupervisor,
  projectId: string,
): Promise<Response> {
  const prompt = turnPrompt(await readJson(request));
  if (prompt === undefined) {
    return jsonError(400, "invalid-turn-request");
  }

  try {
    const run = await supervisor.runProjectTurn(projectId, prompt);
    return run.ok
      ? turnStreamResponse(run.frames)
      : Response.json(
          { ok: false, problem: { code: run.problem.code } },
          { status: TURN_STATUS[run.problem.code] },
        );
  } catch {
    // Nothing of the exception reaches the client: a turn runs a generation's code and a
    // workspace's commands, and their failure text is not this boundary's to hand out.
    return jsonError(500, "internal-error");
  }
}

/**
 * Route one project turn, or answer `undefined` so the owner API can try its other routes.
 *
 * Starting a turn is a state change — it takes the project's turn slot and writes its thread — so
 * it is refused across origins for the reason `routeProjectApiRequest` documents: Access proves
 * the owner, not which page the owner's browser was on.
 */
export function routeProjectTurnRequest(
  request: Request,
  supervisor: TurnApiSupervisor,
): Promise<Response> | undefined {
  const projectId = turnRoute(new URL(request.url).pathname);
  if (projectId === undefined || request.method !== "POST") {
    return undefined;
  }
  if (isCrossOriginMutation(request)) {
    return Promise.resolve(jsonError(403, "cross-origin-request"));
  }

  return turnResponse(request, supervisor, projectId);
}
