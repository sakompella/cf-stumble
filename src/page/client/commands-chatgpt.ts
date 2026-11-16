import * as Option from "effect/Option";
import { Command } from "foldkit";
import * as Schema from "effect/Schema";
import { ChatGPTAnswer } from "./answers.js";
import { type JsonBody } from "./api.js";
import { chatGPTConnection } from "./chatgpt.js";
import { Message } from "./message.js";
import { ownerRequest, rejectedAs } from "./owner-request.js";

const CHATGPT_MESSAGES = [
  Message.SucceededChatGPT,
  Message.RejectedChatGPT,
  Message.FailedChatGPT,
] as const;

function chatGPTRequest(method: "GET" | "POST", path: string, maybeBody: Option.Option<JsonBody>) {
  return ownerRequest(
    { method, path, maybeBody, answer: ChatGPTAnswer },
    {
      answered: (answer) =>
        answer.ok
          ? Message.SucceededChatGPT({ chatgpt: chatGPTConnection(answer.chatgpt) })
          : Message.RejectedChatGPT({
              wording: `rejected: ${answer.problem.code}`,
              maybeChatGPT:
                answer.chatgpt === undefined
                  ? Option.none()
                  : Option.some(chatGPTConnection(answer.chatgpt)),
            }),
      ...rejectedAs((wording) => Message.RejectedChatGPT({ wording, maybeChatGPT: Option.none() })),
      failed: (detail) => Message.FailedChatGPT({ detail }),
    },
  );
}

export const FetchChatGPT = Command.define("FetchChatGPT", {
  messages: CHATGPT_MESSAGES,
  execute: chatGPTRequest("GET", "/api/chatgpt/connection", Option.none()),
});

export const StartChatGPTLogin = Command.define("StartChatGPTLogin", {
  messages: CHATGPT_MESSAGES,
  execute: chatGPTRequest("POST", "/api/chatgpt/login", Option.some({})),
});

export const FinishChatGPTLogin = Command.define("FinishChatGPTLogin", {
  args: { attemptId: Schema.String, callbackUrl: Schema.String },
  messages: CHATGPT_MESSAGES,
  execute: ({ attemptId, callbackUrl }) =>
    chatGPTRequest("POST", "/api/chatgpt/login/complete", Option.some({ attemptId, callbackUrl })),
});

export const DisconnectChatGPT = Command.define("DisconnectChatGPT", {
  messages: CHATGPT_MESSAGES,
  execute: chatGPTRequest("POST", "/api/chatgpt/disconnect", Option.some({})),
});
