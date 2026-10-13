import * as Option from "effect/Option";
import { FetchThread, ReplaceThread } from "./commands.js";
import type { Model, ThreadFacts } from "./model.js";
import { savedTranscript } from "./transcript.js";
import { clearError, withError, type Handlers, type UpdateReturn } from "./update-shared.js";

/**
 * The selected project's saved conversation, and the fresh thread that replaces it.
 *
 * A thread read renders the whole saved conversation, so a second browser — or this one after a
 * reload — sees what the Supervisor committed rather than what one client happened to receive
 * while a turn ran (ADR-0037, ADR-0038). A fresh thread needs two clicks: the first arms it and
 * says what it does, the second sends it.
 */

export function quietThreadRead(model: Model): NonNullable<UpdateReturn["commands"]> {
  return Option.match(model.maybeProjectId, {
    onNone: () => [],
    onSome: (projectId) => [FetchThread({ projectId, selection: model.selection, isQuiet: true })],
  });
}

function withThread(model: Model, thread: ThreadFacts, isReplacing: boolean): Model {
  const facts: Model = {
    ...model,
    conversationState: "ok",
    threadRevision: thread.revision,
    threadTurnActive: thread.turnActive,
    threadMessageCount: thread.messageCount,
  };

  if (!isReplacing) {
    return facts;
  }

  return Option.match(savedTranscript(thread.conversation), {
    onNone: () => ({
      ...facts,
      transcript: [],
      isAssistantOpen: false,
      conversationState: "the saved conversation could not be read",
    }),
    onSome: (transcript) => ({ ...facts, transcript, isAssistantOpen: false }),
  });
}

function startFreshThread(model: Model): UpdateReturn {
  const cleared = clearError(model);

  if (Option.isNone(model.maybeProjectId)) {
    return { model: { ...cleared, freshThreadStatus: "select a project first" } };
  }

  if (model.turn._tag === "Streaming") {
    return { model: { ...cleared, freshThreadStatus: "a turn is running; cancel it first" } };
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
      ReplaceThread({ projectId: model.maybeProjectId.value, selection: model.selection }),
    ],
  };
}

export function threadHandlers(
  model: Model,
): Handlers<
  | "SucceededFetchThread"
  | "RejectedFetchThread"
  | "FailedFetchThread"
  | "ClickedFreshThread"
  | "SucceededFreshThread"
  | "RejectedFreshThread"
  | "FailedFreshThread"
> {
  // An answer for a selection the reader has left belongs to another project, so it changes
  // nothing, whatever it says.
  const forSelection = (selection: number, next: () => Model): UpdateReturn => ({
    model: selection === model.selection ? next() : model,
  });

  return {
    SucceededFetchThread: ({ selection, isQuiet, thread }) =>
      forSelection(selection, () => withThread(model, thread, !isQuiet)),
    RejectedFetchThread: ({ selection, wording }) =>
      forSelection(selection, () => ({ ...model, conversationState: wording })),
    FailedFetchThread: ({ selection, detail }) =>
      forSelection(selection, () => ({
        ...withError(model, "the thread request", detail),
        conversationState: "disconnected from this Worker",
      })),
    ClickedFreshThread: () => startFreshThread(model),
    SucceededFreshThread: ({ selection, thread }) =>
      forSelection(selection, () => ({
        ...withThread(model, thread, true),
        freshThreadStatus: "fresh thread started; repository files are untouched",
        turnState: "",
      })),
    // The conversation is unchanged, so only the fresh thread's own status says why.
    RejectedFreshThread: ({ selection, wording }) =>
      forSelection(selection, () => ({
        ...model,
        freshThreadStatus: `not started: ${wording}`,
        turnState: "",
      })),
    FailedFreshThread: ({ selection, detail }) =>
      forSelection(selection, () => ({
        ...withError(model, "the fresh thread request", detail),
        freshThreadStatus: "request failed",
      })),
  };
}
