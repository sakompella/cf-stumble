import * as Option from "effect/Option";
import { ChatGPT } from "./chatgpt.js";
import { FetchChatGPT, FetchStatus } from "./commands.js";
import {
  EMPTY_CONVERSATION,
  isRunning,
  type Conversation,
} from "../../conversation-view/conversation.js";
import type { Model } from "./model.js";
import { settledOutgoing, withoutQueued } from "./outgoing.js";
import { StreamPhase, wasInterrupted } from "./stream-phase.js";
import { retriedUnconfirmed } from "./update-send.js";
import type { Handlers, UpdateReturn } from "./update-shared.js";
import { transcriptHandlers } from "./update-transcript.js";

function withdrawnWording(count: number, next: Conversation): string {
  return count === 0 || next.inbox.length > 0
    ? ""
    : ` · ${count} queued message${count === 1 ? "" : "s"} withdrawn`;
}

function runEndNote(
  previous: Conversation,
  next: Conversation,
  withdrawn: number,
): Option.Option<string> {
  if (isRunning(next)) return Option.none();

  if (Option.isSome(next.maybeRunFailure)) {
    const reason = next.maybeRunFailure.value;

    return isRunning(previous) || !Option.contains(previous.maybeRunFailure, reason)
      ? Option.some(
          `stopped: ${reason}${reason === "aborted" ? withdrawnWording(withdrawn, next) : ""}`,
        )
      : Option.none();
  }

  return isRunning(previous) ? Option.some("answered") : Option.none();
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
        runNote: "this conversation was replaced by a fresh thread",
      }
    : held;

  const note = runEndNote(model.conversation, conversation, model.queuedAtCancel);
  const ended = isRunning(model.conversation) && !isRunning(conversation);
  const started = !isRunning(model.conversation) && isRunning(conversation);

  const received: UpdateReturn = {
    model: {
      ...model,
      conversation,
      streamPhase: StreamPhase.Live(),
      outgoing: Option.match(model.maybeProjectId, {
        onNone: () => model.outgoing,
        onSome: (projectId) => settledOutgoing(conversation, model.outgoing, projectId),
      }),
      runNote: started ? "" : Option.getOrElse(note, () => model.runNote),
      queuedAtCancel: started || Option.isSome(note) ? 0 : model.queuedAtCancel,
    },
    commands: ended && ChatGPT.guards.Connected(model.chatgpt) ? [FetchChatGPT()] : [],
  };

  return wasInterrupted(held.streamPhase) ? retriedUnconfirmed(received) : received;
}

function connectivityChanged(model: Model, isOnline: boolean): UpdateReturn {
  const next = { model: { ...model, isOnline } };

  return isOnline ? retriedUnconfirmed(next) : next;
}

function disconnected(model: Model, detail: string): UpdateReturn {
  return {
    model: { ...model, streamPhase: StreamPhase.Reconnecting({ detail }) },
    commands: StreamPhase.guards.Live(model.streamPhase) ? [FetchStatus()] : [],
  };
}

export function streamHandlers(
  model: Model,
): Handlers<
  | "ClickedLoadEarlier"
  | "ClickedFillGap"
  | "LoadedTranscript"
  | "FailedLoadTranscript"
  | "AcquiredTranscript"
  | "ReleasedTranscript"
  | "ReceivedConversation"
  | "ReceivedUnreadableEvent"
  | "RefusedEvents"
  | "DisconnectedEvents"
  | "ChangedConnectivity"
> {
  const forStream = (streamId: number, next: () => UpdateReturn): UpdateReturn =>
    streamId === model.eventsStreamId ? next() : { model };

  const showing = (streamPhase: StreamPhase): UpdateReturn => ({
    model: { ...model, streamPhase },
  });

  return {
    ...transcriptHandlers(model),
    ReceivedConversation: ({ streamId, conversation }) =>
      streamId === model.eventsStreamId ? receivedConversation(model, conversation) : { model },
    ChangedConnectivity: ({ isOnline }) => connectivityChanged(model, isOnline),
    ReceivedUnreadableEvent: ({ streamId }) =>
      forStream(streamId, () => showing(StreamPhase.Unreadable())),
    RefusedEvents: ({ streamId, wording }) =>
      forStream(streamId, () => showing(StreamPhase.Refused({ wording }))),
    DisconnectedEvents: ({ streamId, detail }) =>
      forStream(streamId, () => disconnected(model, detail)),
  };
}
