import * as Option from "effect/Option";
import { AbortRun, FetchChatGPT, MintRequestId, ReplaceThread, SendMessage } from "./commands.js";
import { EMPTY_CONVERSATION, newestEntryId, type Conversation } from "./conversation.js";
import type { Model } from "./model.js";
import { unseenOutbox, type OutboxItem } from "./outbox.js";
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

function withoutRequest(model: Model, requestId: string): Model {
  return { ...model, outbox: model.outbox.filter((item) => item.requestId !== requestId) };
}

function withUnsentRequestInPrompt(model: Model, requestId: string): Model {
  const unsent = model.outbox.find((item) => item.requestId === requestId);
  const kept = withoutRequest(model, requestId);

  if (unsent === undefined) {
    return kept;
  }

  return {
    ...kept,
    prompt: model.prompt === "" ? unsent.text : `${unsent.text}\n\n${model.prompt}`,
  };
}

function runEndNote(previous: Conversation, next: Conversation): Option.Option<string> {
  if (!previous.isRunning || next.isRunning) return Option.none();

  return Option.some(
    Option.match(next.maybeRunFailure, {
      onNone: () => "answered",
      onSome: (reason) => `stopped: ${reason}`,
    }),
  );
}

function settledOutbox(model: Model, conversation: Conversation): readonly OutboxItem[] {
  return unseenOutbox(conversation, model.outbox).filter((item) =>
    Option.match(item.maybeSubmissionId, {
      onNone: () => true,
      onSome: (id) =>
        conversation.isRunning || conversation.inbox.some((queued) => queued.id === id),
    }),
  );
}

function receivedConversation(model: Model, conversation: Conversation): UpdateReturn {
  const note = runEndNote(model.conversation, conversation);
  const ended = Option.isSome(note);

  return {
    model: {
      ...model,
      conversation,
      conversationState: "live",
      outbox: settledOutbox(model, conversation),
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
    return { model };
  }

  const item = {
    requestId,
    text: content,
    maybeSubmissionId: Option.none(),
    afterEntry: newestEntryId(model.conversation),
  };

  return {
    model: { ...model, runNote: "", outbox: [...model.outbox, item] },
    commands: [SendMessage({ projectId, requestId, content })],
  };
}

function withSubmissionId(model: Model, requestId: string, submissionId: number): Model {
  return {
    ...model,
    outbox: model.outbox.map((item) =>
      item.requestId === requestId
        ? { ...item, maybeSubmissionId: Option.some(submissionId) }
        : item,
    ),
  };
}

export function composerHandlers(
  model: Model,
): Handlers<
  | "UpdatedPrompt"
  | "ClickedSendTurn"
  | "PressedSendShortcut"
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
    MintedRequestId: (minted) => mintedRequest(model, minted),
    SucceededSend: ({ requestId, submissionId }) => ({
      model: withSubmissionId(model, requestId, submissionId),
    }),
    RejectedSend: ({ requestId, wording }) => ({
      model: { ...withUnsentRequestInPrompt(model, requestId), runNote: wording },
    }),
    FailedSend: ({ requestId, detail }) => ({
      model: {
        ...withError(withUnsentRequestInPrompt(model, requestId), "the message request", detail),
        runNote: "not sent",
      },
    }),
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
    outbox: [],
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
