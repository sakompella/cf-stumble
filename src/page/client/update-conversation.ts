import * as Match from "effect/Match";
import * as Option from "effect/Option";
import { AbortRun, FetchChatGPT, MintRequestId, ReplaceThread, SendMessage } from "./commands.js";
import { applyEvent, EMPTY_CONVERSATION } from "./conversation.js";
import type { AgentEvent } from "./agent-event.js";
import type { Model } from "./model.js";
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

function settledNote(status: string, reason: string | undefined): Option.Option<string> {
  switch (status) {
    case "done":
      return Option.some("answered");
    case "unanswered":
      return Option.some(`stopped: ${reason ?? "unanswered"}`);
    default:
      return Option.none();
  }
}

function withEventFacts(model: Model, event: AgentEvent): Model {
  return Match.value(event).pipe(
    Match.discriminators("type")({
      snapshot: ({ inbox }) => ({
        ...model,
        conversationState: "live",
        outbox: model.outbox.filter((item) =>
          Option.match(item.maybeSubmissionId, {
            onNone: () => true,
            onSome: (id) => inbox.some((queued) => queued.id === id),
          }),
        ),
      }),
      submission: ({ record }) => {
        const placed =
          record.requestId === undefined || record.status === "queued"
            ? model
            : withoutRequest(model, record.requestId);

        return Option.match(settledNote(record.status, record.reason), {
          onNone: () => placed,
          onSome: (runNote) => ({ ...placed, runNote }),
        });
      },
      task_failed: ({ message }) => ({ ...model, runNote: `failed: ${message}` }),
    }),
    Match.orElse(() => model),
  );
}

function receivedEvent(model: Model, event: AgentEvent): UpdateReturn {
  const next = withEventFacts(
    { ...model, conversation: applyEvent(model.conversation, event) },
    event,
  );

  return {
    model: next,
    commands: event.type === "run_end" && model.chatgpt.isConnected ? [FetchChatGPT()] : [],
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

  const item = { requestId, text: content, maybeSubmissionId: Option.none() };

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
  | "ReceivedEvent"
  | "ReceivedUnreadableEvent"
  | "RefusedEvents"
  | "DisconnectedEvents"
> {
  const forStream = (streamId: number, next: () => Model): UpdateReturn =>
    streamId === model.eventsStreamId ? { model: next() } : { model };

  return {
    ClickedFreshThread: () => startFreshThread(model),
    SucceededFreshThread: ({ streamId }) => forStream(streamId, () => freshThread(model)),
    RejectedFreshThread: ({ streamId, wording }) =>
      forStream(streamId, () => ({ ...model, freshThreadStatus: `not started: ${wording}` })),
    FailedFreshThread: ({ streamId, detail }) =>
      forStream(streamId, () => ({
        ...withError(model, "the fresh thread request", detail),
        freshThreadStatus: "request failed",
      })),
    ReceivedEvent: ({ streamId, event }) =>
      streamId === model.eventsStreamId ? receivedEvent(model, event) : { model },
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
