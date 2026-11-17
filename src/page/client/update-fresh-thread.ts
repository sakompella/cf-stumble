import * as Option from "effect/Option";
import { ReplaceThread } from "./commands.js";
import { EMPTY_CONVERSATION } from "./conversation.js";
import { advanceFreshThread, FreshThreadEvent, Ground } from "./fresh-thread.js";
import type { Model } from "./model.js";
import { withoutQueued } from "./outgoing.js";
import { StreamPhase } from "./stream-phase.js";
import { clearError, withError, type Handlers, type UpdateReturn } from "./update-shared.js";

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

export function withOpenedStream(model: Model): Model {
  return {
    ...model,
    eventsStreamId: model.eventsStreamId + 1,
    conversation: EMPTY_CONVERSATION,
    outgoing: withoutQueued(model.outgoing),
    streamPhase: StreamPhase.Reading(),
    freshThread: advanceFreshThread(model.freshThread, FreshThreadEvent.StreamReplaced()).phase,
    runNote: "",
  };
}

function replacedThread(model: Model): UpdateReturn {
  return withFreshThread(withOpenedStream(model), FreshThreadEvent.Succeeded());
}

export function freshThreadHandlers(
  model: Model,
): Handlers<
  | "ClickedFreshThread"
  | "ExpiredFreshThread"
  | "SucceededFreshThread"
  | "RejectedFreshThread"
  | "FailedFreshThread"
> {
  const forStream = (streamId: number, next: () => UpdateReturn): UpdateReturn =>
    streamId === model.eventsStreamId ? next() : { model };

  return {
    ClickedFreshThread: () =>
      withFreshThread(clearError(model), FreshThreadEvent.Clicked({ ground: groundOf(model) })),
    ExpiredFreshThread: () => withFreshThread(model, FreshThreadEvent.Expired()),
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
  };
}
