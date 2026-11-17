import * as Option from "effect/Option";
import { Command } from "foldkit";
import * as Schema from "effect/Schema";
import { refusalText, type JsonBody } from "./api.js";
import { chatGPTConnection } from "./chatgpt.js";
import { Message } from "./message.js";
import { apiRequest, rejectedAs } from "./api-request.js";

const CHATGPT_MESSAGES = [
  Message.SucceededChatGPT,
  Message.RejectedChatGPT,
  Message.FailedChatGPT,
] as const;

type ChatGPTEndpoint =
  | "GET /api/chatgpt/connection"
  | "POST /api/chatgpt/login"
  | "POST /api/chatgpt/login/complete"
  | "POST /api/chatgpt/disconnect";

function chatGPTRequest(endpoint: ChatGPTEndpoint, maybeBody: Option.Option<JsonBody>) {
  return apiRequest(
    { endpoint, maybeBody },
    {
      answered: (answer) =>
        answer.ok
          ? Message.SucceededChatGPT({ chatgpt: chatGPTConnection(answer.chatgpt) })
          : Message.RejectedChatGPT({
              wording: refusalText({ kind: "problem", code: answer.problem.code }),
              maybeChatGPT: Option.some(chatGPTConnection(answer.chatgpt)),
            }),
      ...rejectedAs((wording) => Message.RejectedChatGPT({ wording, maybeChatGPT: Option.none() })),
      failed: (detail) => Message.FailedChatGPT({ detail }),
    },
  );
}

export const FetchChatGPT = Command.define("FetchChatGPT", {
  messages: CHATGPT_MESSAGES,
  execute: chatGPTRequest("GET /api/chatgpt/connection", Option.none()),
});

export const StartChatGPTLogin = Command.define("StartChatGPTLogin", {
  messages: CHATGPT_MESSAGES,
  execute: chatGPTRequest("POST /api/chatgpt/login", Option.some({})),
});

export const FinishChatGPTLogin = Command.define("FinishChatGPTLogin", {
  args: { attemptId: Schema.String, callbackUrl: Schema.String },
  messages: CHATGPT_MESSAGES,
  execute: ({ attemptId, callbackUrl }) =>
    chatGPTRequest("POST /api/chatgpt/login/complete", Option.some({ attemptId, callbackUrl })),
});

export const DisconnectChatGPT = Command.define("DisconnectChatGPT", {
  messages: CHATGPT_MESSAGES,
  execute: chatGPTRequest("POST /api/chatgpt/disconnect", Option.some({})),
});
