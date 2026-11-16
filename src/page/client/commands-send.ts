import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command } from "foldkit";
import { unreadableText } from "./api.js";
import { Message } from "./message.js";
import { apiRequest } from "./api-request.js";
import { sendRefusal } from "./send-refusals.js";

export const MintRequestId = Command.define("MintRequestId", {
  args: { projectId: Schema.String, content: Schema.String },
  messages: [Message.MintedRequestId],
  execute: ({ projectId, content }) =>
    Effect.sync(() =>
      Message.MintedRequestId({ projectId, content, requestId: globalThis.crypto.randomUUID() }),
    ),
});

export const SendMessage = Command.define("SendMessage", {
  args: {
    projectId: Schema.String,
    requestId: Schema.String,
    content: Schema.String,
    budgetMinutes: Schema.Number,
  },
  messages: [Message.SucceededSend, Message.RejectedSend, Message.HeldSend, Message.FailedSend],
  execute: ({ projectId, requestId, content, budgetMinutes }) =>
    apiRequest(
      {
        endpoint: "POST /api/projects/:projectId/messages",
        projectId,
        maybeBody: Option.some({ content, requestId, budgetMinutes }),
      },
      {
        answered: ({ submissionId }) => Message.SucceededSend({ requestId, submissionId }),
        refused: (refusal, status) => {
          const { wording, keepsMessage } = sendRefusal(refusal, status);

          return keepsMessage
            ? Message.HeldSend({ requestId, wording })
            : Message.RejectedSend({ requestId, wording });
        },
        unreadable: (status) => Message.HeldSend({ requestId, wording: unreadableText(status) }),
        failed: (detail) => Message.FailedSend({ requestId, detail }),
      },
    ),
});
