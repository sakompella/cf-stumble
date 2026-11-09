import * as Option from "effect/Option";
import { AbortRun, FetchChatGPT, MintRequestId, ReplaceThread, SendMessage } from "./commands.js";
import { advanceFreshThread, FreshThread, FreshThreadEvent, Ground } from "./fresh-thread.js";
import { EMPTY_CONVERSATION, newestEntryId, type Conversation } from "./conversation.js";
import type { Model } from "./model.js";
import {
  advanceRequest,
  Outgoing,
  OutgoingEvent,
  settledOutgoing,
  withoutQueued,
} from "./outgoing.js";
import { StreamPhase } from "./stream-phase.js";
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
    model: {
      ...cleared,
      prompt: "",
      freshThread: advanceFreshThread(model.freshThread, FreshThreadEvent.Sent()).phase,
    },
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
      streamPhase: StreamPhase.Live(),
      outgoing: Option.match(model.maybeProjectId, {
        onNone: () => model.outgoing,
        onSome: (projectId) => settledOutgoing(conversation, model.outgoing, projectId),
      }),
      runNote: Option.getOrElse(note, () => model.runNote),
    },
    commands: ended && model.chatgpt.isConnected ? [FetchChatGPT()] : [],
  };
}

export const INITIAL_CONVERSATION = {
  conversation: EMPTY_CONVERSATION,
  outgoing: [],
  runNote: "",
  freshThread: FreshThread.Idle(),
} satisfies Partial<Model>;

function groundOf(model: Model): Ground {
  if (Option.isNone(model.maybeProjectId)) return Ground.NoProject();

  return model.conversation.isRunning
    ? Ground.RunActive()
    : Ground.Ready({ projectId: model.maybeProjectId.value, streamId: model.eventsStreamId });
}

function withFreshThread(model: Model, event: FreshThreadEvent): UpdateReturn {
  const step = advanceFreshThread(model.freshThread, event);

  return {
    model: { ...model, freshThread: step.phase },
    commands: step.maybeReplace === undefined ? [] : [ReplaceThread(step.maybeReplace)],
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

function replacedThread(model: Model): UpdateReturn {
  return withFreshThread(
    {
      ...model,
      eventsStreamId: model.eventsStreamId + 1,
      conversation: EMPTY_CONVERSATION,
      outgoing: withoutQueued(model.outgoing),
      streamPhase: StreamPhase.Reading(),
      runNote: "",
    },
    FreshThreadEvent.Succeeded(),
  );
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
  const forStream = (streamId: number, next: () => UpdateReturn): UpdateReturn =>
    streamId === model.eventsStreamId ? next() : { model };

  const showing = (streamPhase: StreamPhase): UpdateReturn => ({
    model: { ...model, streamPhase },
  });

  return {
    ...transcriptHandlers(model),
    ClickedFreshThread: () =>
      withFreshThread(clearError(model), FreshThreadEvent.Clicked({ ground: groundOf(model) })),
    SucceededFreshThread: ({ streamId }) => forStream(streamId, () => replacedThread(model)),
    RejectedFreshThread: ({ streamId, wording }) =>
      forStream(streamId, () => withFreshThread(model, FreshThreadEvent.Refused({ wording }))),
    FailedFreshThread: ({ streamId, detail }) =>
      forStream(streamId, () =>
        withFreshThread(
          withError(model, "the fresh thread request", detail),
          FreshThreadEvent.Failed(),
        ),
      ),
    ReceivedConversation: ({ streamId, conversation }) =>
      streamId === model.eventsStreamId ? receivedConversation(model, conversation) : { model },
    ReceivedUnreadableEvent: ({ streamId }) =>
      forStream(streamId, () => showing(StreamPhase.Unreadable())),
    RefusedEvents: ({ streamId, wording }) =>
      forStream(streamId, () => showing(StreamPhase.Refused({ wording }))),
    DisconnectedEvents: ({ streamId, detail }) =>
      forStream(streamId, () => showing(StreamPhase.Reconnecting({ detail }))),
  };
}
