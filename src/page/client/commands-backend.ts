import * as Option from "effect/Option";
import { Command } from "foldkit";
import { BackendAnswer } from "./answers.js";
import { type JsonBody } from "./api.js";
import { BackendSetting } from "../../backend-setting.js";
import { Message } from "./message.js";
import { apiRequest, rejectedAs } from "./api-request.js";

const BACKEND_MESSAGES = [
  Message.SucceededBackend,
  Message.RejectedBackend,
  Message.FailedBackend,
] as const;

function backendRequest(
  endpoint: "GET /api/workspace/backend" | "POST /api/workspace/backend",
  maybeBody: Option.Option<JsonBody>,
) {
  return apiRequest(
    { target: { endpoint }, maybeBody, answer: BackendAnswer },
    {
      answered: (answer) =>
        answer.ok
          ? Message.SucceededBackend({ backend: answer.backend })
          : Message.RejectedBackend({ wording: `rejected: ${answer.problem.code}` }),
      ...rejectedAs((wording) => Message.RejectedBackend({ wording })),
      failed: (detail) => Message.FailedBackend({ detail }),
    },
  );
}

export const FetchBackend = Command.define("FetchBackend", {
  messages: BACKEND_MESSAGES,
  execute: backendRequest("GET /api/workspace/backend", Option.none()),
});

export const ChangeBackend = Command.define("ChangeBackend", {
  args: { backend: BackendSetting },
  messages: BACKEND_MESSAGES,
  execute: ({ backend }) => backendRequest("POST /api/workspace/backend", Option.some({ backend })),
});
