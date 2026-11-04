import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command } from "foldkit";
import { BackendSetting, decodeBackendSetting } from "../../backend-setting.js";
import { field, isOk, problemText, requestJson, type Answer, type JsonBody } from "./api.js";
import { Message } from "./message.js";

const BACKEND_MESSAGES = [
  Message.SucceededBackend,
  Message.RejectedBackend,
  Message.FailedBackend,
] as const;

type BackendAnswer = Extract<Message, { readonly _tag: "SucceededBackend" | "RejectedBackend" }>;

function backendAnswer(answer: Answer): BackendAnswer {
  const backend = decodeBackendSetting(field(answer.payload, "backend"));

  return isOk(answer.payload) && Option.isSome(backend)
    ? Message.SucceededBackend({ backend: backend.value })
    : Message.RejectedBackend({ wording: problemText(answer) });
}

function backendRequest(method: "GET" | "POST", maybeBody: Option.Option<JsonBody>) {
  return requestJson(method, "/api/workspace/backend", maybeBody).pipe(
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
