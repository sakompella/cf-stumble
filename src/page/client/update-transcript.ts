import * as Option from "effect/Option";
import { LoadTranscript } from "./commands.js";
import type { Model } from "./model.js";
import { withError, type Handlers } from "./update-shared.js";

export function transcriptHandlers(
  model: Model,
): Handlers<"ClickedLoadEarlier" | "ClickedFillGap" | "LoadedTranscript" | "FailedLoadTranscript"> {
  const load = (maybeGapIndex: Option.Option<number>) => ({
    model,
    commands: [LoadTranscript({ streamId: model.eventsStreamId, maybeGapIndex })],
  });

  return {
    ClickedLoadEarlier: () => load(Option.none()),
    ClickedFillGap: ({ itemIndex }) => load(Option.some(itemIndex)),
    LoadedTranscript: ({ streamId, maybeItems }) =>
      streamId === model.eventsStreamId && Option.isSome(maybeItems)
        ? { model: { ...model, conversation: { ...model.conversation, items: maybeItems.value } } }
        : { model },
    FailedLoadTranscript: ({ streamId, detail }) =>
      streamId === model.eventsStreamId
        ? { model: withError(model, "the earlier messages request", detail) }
        : { model },
  };
}
