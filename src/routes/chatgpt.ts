import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ChatGPTConnectionView, ChatGPTLoginOutcome } from "../chatgpt/index.js";
import {
  callSupervisor,
  decodeRequestBody,
  invalidRequestBody,
  refusal,
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

const CompleteBody = Schema.Struct({ attemptId: Schema.String, callbackUrl: Schema.String });

const completeResponse = Effect.fnUntraced(function* (
  request: Request,
  supervisor: ChatGPTApiSupervisor,
) {
  const body = yield* decodeRequestBody(request, CompleteBody);

  const outcome = yield* callSupervisor(() =>
    supervisor.completeChatGPTLogin(body.attemptId, body.callbackUrl),
  );

  return outcome.ok ? Response.json(outcome) : refusal(outcome);
}, invalidRequestBody("invalid-chatgpt-request"));

function viewResponse(
  read: () => Promise<ChatGPTConnectionView>,
): Effect.Effect<Response, SupervisorCallFailed> {
  return callSupervisor(read).pipe(Effect.map((chatgpt) => Response.json({ ok: true, chatgpt })));
}

export const CHATGPT_HANDLERS: Handlers<
  ChatGPTApiSupervisor,
  | "GET /api/chatgpt/connection"
  | "POST /api/chatgpt/login"
  | "POST /api/chatgpt/login/complete"
  | "POST /api/chatgpt/disconnect"
> = {
  "GET /api/chatgpt/connection": (_request, supervisor) =>
    viewResponse(() => supervisor.getChatGPTConnection()),
  "POST /api/chatgpt/login": (_request, supervisor) =>
    viewResponse(() => supervisor.startChatGPTLogin()),
  "POST /api/chatgpt/login/complete": completeResponse,
  "POST /api/chatgpt/disconnect": (_request, supervisor) =>
    viewResponse(() => supervisor.disconnectChatGPT()),
};
