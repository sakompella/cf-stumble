import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command } from "foldkit";
import { Message } from "./message.js";
import { apiRequest } from "./api-request.js";
import { disconnectRefusal } from "./disconnect-refusals.js";
import { unreadableText } from "./api.js";

export const DisconnectRepository = Command.define("DisconnectRepository", {
  args: { projectId: Schema.String },
  messages: [Message.SucceededDisconnect, Message.RejectedDisconnect, Message.FailedDisconnect],
  execute: ({ projectId }) =>
    apiRequest(
      {
        endpoint: "POST /api/projects/:projectId/disconnect",
        projectId,
        maybeBody: Option.some({}),
      },
      {
        answered: (answer) =>
          Message.SucceededDisconnect({ projectId, workspace: answer.workspace }),
        refused: (refusal) => Message.RejectedDisconnect({ wording: disconnectRefusal(refusal) }),
        unreadable: (status) =>
          Message.RejectedDisconnect({ wording: `not disconnected: ${unreadableText(status)}` }),
        failed: (detail) => Message.FailedDisconnect({ detail }),
      },
    ),
});
