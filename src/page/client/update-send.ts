import * as Option from "effect/Option";
import { MintRequestId, SendMessage } from "./commands.js";
import { advanceFreshThread, FreshThreadEvent } from "./fresh-thread.js";
import { newestEntryId } from "../../conversation-view/conversation.js";
import type { Model } from "./model.js";
import { advanceRequest, Outgoing, OutgoingEvent } from "./outgoing.js";
import { clearError, withError, type Handlers, type UpdateReturn } from "./update-shared.js";

export function send(model: Model): UpdateReturn {
  const cleared = clearError(model);
  const content = model.prompt.trim();

  if (Option.isNone(model.maybeProjectId)) {
    return { model: { ...cleared, runNote: "select a project first" } };
  }

  if (content === "") {
    return { model: { ...cleared, runNote: "type a prompt first" } };
  }

  return {
    model: {
      ...cleared,
      prompt: "",
      freshThread: advanceFreshThread(model.freshThread, FreshThreadEvent.Sent()).phase,
    },
    commands: [MintRequestId({ projectId: model.maybeProjectId.value, content })],
  };
}

const NOT_CONFIRMED = "not confirmed: sent again when the connection is back, or press Retry";

function textAbove(text: string, rest: string): string {
  return rest === "" ? text : `${text}\n\n${rest}`;
}

function withTextRestored(model: Model, projectId: string, text: string): Model {
  return Option.contains(model.maybeProjectId, projectId)
    ? { ...model, prompt: textAbove(text, model.prompt) }
    : {
        ...model,
        drafts: { ...model.drafts, [projectId]: textAbove(text, model.drafts[projectId] ?? "") },
      };
}

function advanced(model: Model, requestId: string, event: OutgoingEvent): Model {
  const step = advanceRequest(model.outgoing, requestId, event);
  const next = { ...model, outgoing: step.outgoing };

  return Option.isSome(step.before) && Option.isNone(step.after)
    ? withTextRestored(next, step.before.value.projectId, step.before.value.text)
    : next;
}

function retried(model: Model, requestId: string): UpdateReturn {
  const step = advanceRequest(model.outgoing, requestId, OutgoingEvent.Retried());

  return Option.match(step.before, {
    onNone: () => ({ model }),
    onSome: (before) =>
      Outgoing.guards.Unconfirmed(before)
        ? {
            model: { ...clearError(model), outgoing: step.outgoing, runNote: "" },
            commands: [
              SendMessage({
                projectId: before.projectId,
                requestId,
                content: before.text,
                budgetMinutes: before.budgetMinutes,
              }),
            ],
          }
        : { model },
  });
}

export function retriedUnconfirmed(step: UpdateReturn): UpdateReturn {
  const { model } = step;

  return model.outgoing
    .filter(
      (item) =>
        Outgoing.guards.Unconfirmed(item) && Option.contains(model.maybeProjectId, item.projectId),
    )
    .reduce<UpdateReturn>((sofar, item) => {
      const next = retried(sofar.model, item.requestId);

      return { model: next.model, commands: [...(sofar.commands ?? []), ...(next.commands ?? [])] };
    }, step);
}

function mintedRequest(
  model: Model,
  {
    projectId,
    requestId,
    content,
  }: Readonly<{ projectId: string; requestId: string; content: string }>,
): UpdateReturn {
  if (!Option.contains(model.maybeProjectId, projectId)) {
    return { model: withTextRestored(model, projectId, content) };
  }

  const item = Outgoing.Sending({
    requestId,
    projectId,
    text: content,
    afterEntry: newestEntryId(model.conversation),
    budgetMinutes: model.runBudget,
  });

  return {
    model: { ...model, runNote: "", outgoing: [...model.outgoing, item] },
    commands: [SendMessage({ projectId, requestId, content, budgetMinutes: model.runBudget })],
  };
}

export function sendResultHandlers(
  model: Model,
): Handlers<
  | "ClickedRetrySend"
  | "MintedRequestId"
  | "SucceededSend"
  | "RejectedSend"
  | "HeldSend"
  | "FailedSend"
> {
  return {
    MintedRequestId: (minted) => mintedRequest(model, minted),
    ClickedRetrySend: ({ requestId }) => retried(model, requestId),
    SucceededSend: ({ requestId, submissionId }) => ({
      model: advanced(model, requestId, OutgoingEvent.Admitted({ submissionId })),
    }),
    RejectedSend: ({ requestId, wording }) => ({
      model: { ...advanced(model, requestId, OutgoingEvent.Refused()), runNote: wording },
    }),
    HeldSend: ({ requestId, wording }) => ({
      model: {
        ...advanced(model, requestId, OutgoingEvent.Lost()),
        pageError: wording,
        runNote: NOT_CONFIRMED,
      },
    }),
    FailedSend: ({ requestId, detail }) => ({
      model: {
        ...withError(
          advanced(model, requestId, OutgoingEvent.Lost()),
          "the message request",
          detail,
        ),
        runNote: NOT_CONFIRMED,
      },
    }),
  };
}
