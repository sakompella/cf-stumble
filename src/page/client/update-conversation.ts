import * as Option from "effect/Option";
import { AbortRun } from "./commands.js";
import type { Model } from "./model.js";
import { freshThreadHandlers } from "./update-fresh-thread.js";
import { send, sendResultHandlers } from "./update-send.js";
import { streamHandlers } from "./update-stream.js";
import { clearError, withError, type Handlers } from "./update-shared.js";

export function composerHandlers(
  model: Model,
): Handlers<
  | "UpdatedPrompt"
  | "ClickedSendTurn"
  | "PressedSendShortcut"
  | "ClickedRetrySend"
  | "MintedRequestId"
  | "SucceededSend"
  | "RejectedSend"
  | "HeldSend"
  | "FailedSend"
  | "ClickedCancelTurn"
  | "SucceededAbort"
  | "RejectedAbort"
  | "FailedAbort"
> {
  return {
    UpdatedPrompt: ({ value }) => ({ model: { ...model, prompt: value } }),
    ClickedSendTurn: () => send(model),
    PressedSendShortcut: () => send(model),
    ...sendResultHandlers(model),
    ClickedCancelTurn: () =>
      Option.match(model.maybeProjectId, {
        onNone: () => ({ model }),
        onSome: (projectId) => ({
          model: {
            ...clearError(model),
            runNote: "cancelling",
            queuedAtCancel: model.conversation.inbox.length,
          },
          commands: [AbortRun({ projectId })],
        }),
      }),
    SucceededAbort: () => ({ model }),
    RejectedAbort: ({ wording }) => ({ model: { ...model, runNote: `not cancelled: ${wording}` } }),
    FailedAbort: ({ detail }) => ({
      model: { ...withError(model, "the cancel request", detail), runNote: "not cancelled" },
    }),
  };
}

export function conversationHandlers(
  model: Model,
): ReturnType<typeof composerHandlers> &
  ReturnType<typeof streamHandlers> &
  ReturnType<typeof freshThreadHandlers> {
  return { ...composerHandlers(model), ...streamHandlers(model), ...freshThreadHandlers(model) };
}
