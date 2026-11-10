import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command } from "foldkit";
import { BackendAnswer } from "./answers.js";
import { type Answered, refusalWording, requestJson, type JsonBody } from "./api.js";
import { BackendSetting } from "../../backend-setting.js";
import { Message } from "./message.js";

const BACKEND_MESSAGES = [
  Message.SucceededBackend,
  Message.RejectedBackend,
  Message.FailedBackend,
] as const;

type BackendAnswerMessage = Extract<
  Message,
  { readonly _tag: "SucceededBackend" | "RejectedBackend" }
>;

function backendAnswer(answered: Answered<typeof BackendAnswer.Type>): BackendAnswerMessage {
  return Option.match(answered.maybeAnswer, {
    onNone: () => Message.RejectedBackend({ wording: refusalWording(answered) }),
    onSome: (answer) =>
      answer.ok
        ? Message.SucceededBackend({ backend: answer.backend })
        : Message.RejectedBackend({ wording: `rejected: ${answer.problem.code}` }),
  });
}

function backendRequest(method: "GET" | "POST", maybeBody: Option.Option<JsonBody>) {
  return requestJson(method, "/api/workspace/backend", maybeBody, BackendAnswer).pipe(
    Effect.map(backendAnswer),
    Effect.catch((detail) => Effect.succeed(Message.FailedBackend({ detail }))),
  );
}

export const FetchBackend = Command.define("FetchBackend", {
  messages: BACKEND_MESSAGES,
  execute: backendRequest("GET", Option.none()),
});

export const ChangeBackend = Command.define("ChangeBackend", {
  args: { backend: BackendSetting },
  messages: BACKEND_MESSAGES,
  execute: ({ backend }) => backendRequest("POST", Option.some({ backend })),
});
