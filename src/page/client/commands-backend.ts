import * as Option from "effect/Option";
import { Command } from "foldkit";
import { BackendSetting } from "../../backend-setting.js";
import { Message } from "./message.js";
import { apiRequest, rejectedAs } from "./api-request.js";

const BACKEND_MESSAGES = [
  Message.SucceededBackend,
  Message.ChangedBackend,
  Message.RejectedBackend,
  Message.FailedBackend,
] as const;

const failures = {
  ...rejectedAs((wording) => Message.RejectedBackend({ wording })),
  failed: (detail: string) => Message.FailedBackend({ detail }),
};

export const FetchBackend = Command.define("FetchBackend", {
  messages: BACKEND_MESSAGES,
  execute: apiRequest(
    { endpoint: "GET /api/workspace/backend", maybeBody: Option.none() },
    {
      answered: (answer) => Message.SucceededBackend({ backend: answer.backend }),
      ...failures,
    },
  ),
});

export const ChangeBackend = Command.define("ChangeBackend", {
  args: { backend: BackendSetting },
  messages: BACKEND_MESSAGES,
  execute: ({ backend }) =>
    apiRequest(
      { endpoint: "POST /api/workspace/backend", maybeBody: Option.some({ backend }) },
      {
        answered: (answer) =>
          Message.ChangedBackend({
            backend: answer.backend,
            container: answer.container,
            startsOn: answer.startsOn,
          }),
        ...failures,
      },
    ),
});
