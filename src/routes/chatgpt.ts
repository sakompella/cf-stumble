import * as Effect from "effect/Effect";
import { LoginCompletion } from "../api/answers.js";
import { PROBLEM_STATUS } from "../api/problems.js";
import type { ChatGPTConnectionView, ChatGPTLoginOutcome } from "../chatgpt/index.js";
import {
  answer,
  callSupervisor,
  decodeRequestBody,
  invalidRequestBody,
  type Handlers,
  type SupervisorCallFailed,
} from "./json.js";

export type ChatGPTApiSupervisor = {
  readonly getChatGPTConnection: () => Promise<ChatGPTConnectionView>;
  readonly startChatGPTLogin: () => Promise<ChatGPTConnectionView>;
  readonly completeChatGPTLogin: (
    attemptId: string,
    callbackUrl: string,
  ) => Promise<ChatGPTLoginOutcome>;
  readonly disconnectChatGPT: () => Promise<ChatGPTConnectionView>;
};

const completeResponse = Effect.fnUntraced(function* (
  request: Request,
  supervisor: ChatGPTApiSupervisor,
) {
  const body = yield* decodeRequestBody(request, LoginCompletion);

  const outcome = yield* callSupervisor(() =>
    supervisor.completeChatGPTLogin(body.attemptId, body.callbackUrl),
  );

  return answer(
    "POST /api/chatgpt/login/complete",
    outcome,
    outcome.ok ? 200 : PROBLEM_STATUS[outcome.problem.code],
  );
}, invalidRequestBody("invalid-chatgpt-request"));

function viewResponse(
  endpoint:
    | "GET /api/chatgpt/connection"
    | "POST /api/chatgpt/login"
    | "POST /api/chatgpt/disconnect",
  read: () => Promise<ChatGPTConnectionView>,
): Effect.Effect<Response, SupervisorCallFailed> {
  return callSupervisor(read).pipe(
    Effect.map((chatgpt) => answer(endpoint, { ok: true, chatgpt })),
  );
}

export const CHATGPT_HANDLERS: Handlers<
  ChatGPTApiSupervisor,
  | "GET /api/chatgpt/connection"
  | "POST /api/chatgpt/login"
  | "POST /api/chatgpt/login/complete"
  | "POST /api/chatgpt/disconnect"
> = {
  "GET /api/chatgpt/connection": (_request, supervisor) =>
    viewResponse("GET /api/chatgpt/connection", () => supervisor.getChatGPTConnection()),
  "POST /api/chatgpt/login": (_request, supervisor) =>
    viewResponse("POST /api/chatgpt/login", () => supervisor.startChatGPTLogin()),
  "POST /api/chatgpt/login/complete": completeResponse,
  "POST /api/chatgpt/disconnect": (_request, supervisor) =>
    viewResponse("POST /api/chatgpt/disconnect", () => supervisor.disconnectChatGPT()),
};
