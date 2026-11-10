import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command } from "foldkit";
import * as Schema from "effect/Schema";
import { ChatGPTAnswer } from "./answers.js";
import { type Answered, refusalWording, requestJson, type JsonBody } from "./api.js";
import { chatGPTConnection } from "./chatgpt.js";
import { Message } from "./message.js";

type ChatGPTAnswerMessage = Extract<
  Message,
  { readonly _tag: "SucceededChatGPT" | "RejectedChatGPT" }
>;

function chatGPTAnswer(answered: Answered<typeof ChatGPTAnswer.Type>): ChatGPTAnswerMessage {
  return Option.match(answered.maybeAnswer, {
    onNone: () =>
      Message.RejectedChatGPT({ wording: refusalWording(answered), maybeChatGPT: Option.none() }),
    onSome: (answer) =>
      answer.ok
        ? Message.SucceededChatGPT({ chatgpt: chatGPTConnection(answer.chatgpt) })
        : Message.RejectedChatGPT({
            wording: `rejected: ${answer.problem.code}`,
            maybeChatGPT:
              answer.chatgpt === undefined
                ? Option.none()
                : Option.some(chatGPTConnection(answer.chatgpt)),
          }),
  });
}

const CHATGPT_MESSAGES = [
  Message.SucceededChatGPT,
  Message.RejectedChatGPT,
  Message.FailedChatGPT,
] as const;

function chatGPTRequest(method: "GET" | "POST", path: string, maybeBody: Option.Option<JsonBody>) {
  return requestJson(method, path, maybeBody, ChatGPTAnswer).pipe(
    Effect.map(chatGPTAnswer),
    Effect.catch((detail) => Effect.succeed(Message.FailedChatGPT({ detail }))),
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
