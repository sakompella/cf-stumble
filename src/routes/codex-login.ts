import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  CodexLoginConnectionView,
  CodexLoginFailure,
  CodexLoginOutcome,
} from "../codex-login/index.js";
import { callSupervisor, decodeRequestBody, jsonError, type SupervisorCallFailed } from "./json.js";

export type CodexLoginApiSupervisor = {
  readonly getCodexLoginConnection: () => Promise<CodexLoginConnectionView>;
  readonly startCodexLogin: () => Promise<CodexLoginConnectionView>;
  readonly completeCodexLogin: (
    attemptId: string,
    callbackUrl: string,
  ) => Promise<CodexLoginOutcome>;
  readonly disconnectCodexLogin: () => Promise<CodexLoginConnectionView>;
};

function loginStatus(code: CodexLoginFailure): number {
  return code === "exchange-unavailable" ? 503 : 400;
}

const CompleteBody = Schema.Struct({ attemptId: Schema.String, callbackUrl: Schema.String });

const completeResponse = Effect.fnUntraced(
  function* (request: Request, supervisor: CodexLoginApiSupervisor) {
    const body = yield* decodeRequestBody(request, CompleteBody);

    const outcome = yield* callSupervisor(() =>
      supervisor.completeCodexLogin(body.attemptId, body.callbackUrl),
    );

    return outcome.ok
      ? Response.json(outcome)
      : Response.json(outcome, { status: loginStatus(outcome.problem.code) });
  },
  Effect.catchTag("InvalidRequestBody", () =>
    Effect.succeed(jsonError(400, "invalid-codex-login-request")),
  ),
);

function viewResponse(
  read: () => Promise<CodexLoginConnectionView>,
): Effect.Effect<Response, SupervisorCallFailed> {
  return callSupervisor(read).pipe(
    Effect.map((codexLogin) => Response.json({ ok: true, codexLogin })),
  );
}

export function routeCodexLoginApiRequest(
  request: Request,
  supervisor: CodexLoginApiSupervisor,
): Effect.Effect<Response, SupervisorCallFailed> | undefined {
  const pathname = new URL(request.url).pathname;

  if (request.method === "GET" && pathname === "/api/codex-login/connection") {
    return viewResponse(() => supervisor.getCodexLoginConnection());
  }

  if (request.method !== "POST") return undefined;

  switch (pathname) {
    case "/api/codex-login/login":
      return viewResponse(() => supervisor.startCodexLogin());
    case "/api/codex-login/login/complete":
      return completeResponse(request, supervisor);
    case "/api/codex-login/disconnect":
      return viewResponse(() => supervisor.disconnectCodexLogin());
    default:
      return undefined;
  }
}
