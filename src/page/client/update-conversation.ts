import * as Option from "effect/Option";
import { AbortRun, FetchChatGPT, MintRequestId, ReplaceThread, SendMessage } from "./commands.js";
import { EMPTY_CONVERSATION, newestEntryId, type Conversation } from "./conversation.js";
import type { Model } from "./model.js";
import {
  advanceRequest,
  Outgoing,
  OutgoingEvent,
  settledOutgoing,
  withoutQueued,
} from "./outgoing.js";
import { transcriptHandlers } from "./update-transcript.js";
import { clearError, withError, type Handlers, type UpdateReturn } from "./update-shared.js";

function send(model: Model): UpdateReturn {
  const cleared = clearError(model);
  const content = model.prompt.trim();

  if (Option.isNone(model.maybeProjectId)) {
    return { model: { ...cleared, runNote: "select a project first" } };
  }

  if (content === "") {
    return { model: { ...cleared, runNote: "type a prompt first" } };
  }

  return {
    model: { ...cleared, prompt: "", isFreshArmed: false, freshThreadStatus: "" },
    commands: [MintRequestId({ projectId: model.maybeProjectId.value, content })],
  };
}

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
              }),
            ],
          }
        : { model },
  });
}

function runEndNote(previous: Conversation, next: Conversation): Option.Option<string> {
  if (next.isRunning) return Option.none();

  if (Option.isSome(next.maybeRunFailure)) {
    const reason = next.maybeRunFailure.value;

    return previous.isRunning || !Option.contains(previous.maybeRunFailure, reason)
      ? Option.some(`stopped: ${reason}`)
      : Option.none();
  }

  return previous.isRunning ? Option.some("answered") : Option.none();
}

function isReplacement(previous: Conversation, next: Conversation): boolean {
  return Option.isSome(previous.maybeId) && !Option.contains(next.maybeId, previous.maybeId.value);
}

function receivedConversation(held: Model, conversation: Conversation): UpdateReturn {
  const replaced = isReplacement(held.conversation, conversation);

  const model = replaced
    ? {
        ...held,
        conversation: EMPTY_CONVERSATION,
        outgoing: withoutQueued(held.outgoing),
        runNote: "",
      }
    : held;

  const note = runEndNote(model.conversation, conversation);
  const ended = model.conversation.isRunning && !conversation.isRunning;

  return {
    model: {
      ...model,
      conversation,
      conversationState: "live",
      outgoing: Option.match(model.maybeProjectId, {
        onNone: () => model.outgoing,
        onSome: (projectId) => settledOutgoing(conversation, model.outgoing, projectId),
      }),
      runNote: Option.getOrElse(note, () => model.runNote),
    },
    commands: ended && model.chatgpt.isConnected ? [FetchChatGPT()] : [],
  };
}

function startFreshThread(model: Model): UpdateReturn {
  const cleared = clearError(model);

  if (Option.isNone(model.maybeProjectId)) {
    return { model: { ...cleared, freshThreadStatus: "select a project first" } };
  }

  if (model.conversation.isRunning) {
    return { model: { ...cleared, freshThreadStatus: "a run is active; cancel it first" } };
  }

  if (!model.isFreshArmed) {
    return {
      model: {
        ...cleared,
        isFreshArmed: true,
        freshThreadStatus:
          "click again to replace this conversation; repository files are untouched",
      },
    };
  }

  return {
    model: { ...cleared, isFreshArmed: false, freshThreadStatus: "starting a fresh thread" },
    commands: [
      ReplaceThread({ projectId: model.maybeProjectId.value, streamId: model.eventsStreamId }),
    ],
  };
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
  });

  return {
    model: { ...model, runNote: "", outgoing: [...model.outgoing, item] },
    commands: [SendMessage({ projectId, requestId, content })],
  };
}

function sendResultHandlers(
  model: Model,
): Handlers<
  "ClickedRetrySend" | "MintedRequestId" | "SucceededSend" | "RejectedSend" | "FailedSend"
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
    FailedSend: ({ requestId, detail }) => ({
      model: {
        ...withError(
          advanced(model, requestId, OutgoingEvent.Lost()),
          "the message request",
          detail,
        ),
        runNote: "not confirmed: retry it in the conversation",
      },
    }),
  };
}

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
          model: { ...clearError(model), runNote: "cancelling" },
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

function freshThread(model: Model): Model {
  return {
    ...model,
    eventsStreamId: model.eventsStreamId + 1,
    conversation: EMPTY_CONVERSATION,
    outgoing: withoutQueued(model.outgoing),
    conversationState: "reading",
    runNote: "",
    freshThreadStatus: "fresh thread started; repository files are untouched",
  };
}

export function streamHandlers(
  model: Model,
): Handlers<
  | "ClickedFreshThread"
  | "SucceededFreshThread"
  | "RejectedFreshThread"
  | "FailedFreshThread"
  | "ReceivedConversation"
  | "ClickedLoadEarlier"
  | "ClickedFillGap"
  | "LoadedTranscript"
  | "FailedLoadTranscript"
  | "ReceivedUnreadableEvent"
  | "RefusedEvents"
  | "DisconnectedEvents"
> {
  const forStream = (streamId: number, next: () => Model): UpdateReturn =>
    streamId === model.eventsStreamId ? { model: next() } : { model };

  return {
    ...transcriptHandlers(model),
    ClickedFreshThread: () => startFreshThread(model),
    SucceededFreshThread: ({ streamId }) => forStream(streamId, () => freshThread(model)),
    RejectedFreshThread: ({ streamId, wording }) =>
      forStream(streamId, () => ({ ...model, freshThreadStatus: `not started: ${wording}` })),
    FailedFreshThread: ({ streamId, detail }) =>
      forStream(streamId, () => ({
        ...withError(model, "the fresh thread request", detail),
        freshThreadStatus: "request failed",
      })),
    ReceivedConversation: ({ streamId, conversation }) =>
      streamId === model.eventsStreamId ? receivedConversation(model, conversation) : { model },
    ReceivedUnreadableEvent: ({ streamId }) =>
      forStream(streamId, () => ({
        ...model,
        conversationState: "unreadable event from this Worker",
      })),
    RefusedEvents: ({ streamId, wording }) =>
      forStream(streamId, () => ({ ...model, conversationState: wording })),
    DisconnectedEvents: ({ streamId, detail }) =>
      forStream(streamId, () => ({ ...model, conversationState: `reconnecting: ${detail}` })),
  };
}
