import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  ChatGPTConnectionView,
  ChatGPTLoginFailure,
  ChatGPTLoginOutcome,
} from "../chatgpt/index.js";
import { callSupervisor, decodeRequestBody, jsonError, type SupervisorCallFailed } from "./json.js";

export type ChatGPTApiSupervisor = {
  readonly getChatGPTConnection: () => Promise<ChatGPTConnectionView>;
  readonly startChatGPTLogin: () => Promise<ChatGPTConnectionView>;
  readonly completeChatGPTLogin: (
    attemptId: string,
    callbackUrl: string,
  ) => Promise<ChatGPTLoginOutcome>;
  readonly disconnectChatGPT: () => Promise<ChatGPTConnectionView>;
};

/** A busy token endpoint is worth another try; every other refusal needs a new sign-in or address. */
function loginStatus(code: ChatGPTLoginFailure): number {
  return code === "exchange-unavailable" ? 503 : 400;
}

/** The sign-in attempt and the address the browser ended on, which carries the one-time code. */
const CompleteBody = Schema.Struct({ attemptId: Schema.String, callbackUrl: Schema.String });

const completeResponse = Effect.fnUntraced(
  function* (request: Request, supervisor: ChatGPTApiSupervisor) {
    const body = yield* decodeRequestBody(request, CompleteBody);

    const outcome = yield* callSupervisor(() =>
      supervisor.completeChatGPTLogin(body.attemptId, body.callbackUrl),
    );

    return outcome.ok
      ? Response.json(outcome)
      : Response.json(outcome, { status: loginStatus(outcome.problem.code) });
  },
  Effect.catchTag("InvalidRequestBody", () =>
    Effect.succeed(jsonError(400, "invalid-chatgpt-request")),
  ),
);

function viewResponse(
  read: () => Promise<ChatGPTConnectionView>,
): Effect.Effect<Response, SupervisorCallFailed> {
  return callSupervisor(read).pipe(Effect.map((chatgpt) => Response.json({ ok: true, chatgpt })));
}

/**
 * The owner's ChatGPT connection (ADR-0047): read it, start a sign-in, finish it with the address
 * the sign-in ended on, or disconnect. No answer carries a token, a verifier, or a code. Answers
 * `undefined` for any other request, so the owner API can try its other routes.
 */
export function routeChatGPTApiRequest(
  request: Request,
  supervisor: ChatGPTApiSupervisor,
): Effect.Effect<Response, SupervisorCallFailed> | undefined {
  const pathname = new URL(request.url).pathname;

  if (request.method === "GET" && pathname === "/api/chatgpt/connection") {
    return viewResponse(() => supervisor.getChatGPTConnection());
  }

  if (request.method !== "POST") return undefined;

  switch (pathname) {
    case "/api/chatgpt/login":
      return viewResponse(() => supervisor.startChatGPTLogin());
    case "/api/chatgpt/login/complete":
      return completeResponse(request, supervisor);
    case "/api/chatgpt/disconnect":
      return viewResponse(() => supervisor.disconnectChatGPT());
    default:
      return undefined;
  }
}
