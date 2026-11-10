import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command } from "foldkit";
import * as Schema from "effect/Schema";
import { loadIntoTranscript } from "./transcript-store.js";
import { conversationOf } from "./conversation.js";
import { Message } from "./message.js";

export const LoadTranscript = Command.define("LoadTranscript", {
  args: { streamId: Schema.Number, maybeGapIndex: Schema.Option(Schema.Number) },
  messages: [Message.LoadedTranscript, Message.FailedLoadTranscript],
  execute: ({ streamId, maybeGapIndex }) =>
    loadIntoTranscript(Option.getOrUndefined(maybeGapIndex)).pipe(
      Effect.map((loaded) =>
        Message.LoadedTranscript({
          streamId,
          maybeItems: Option.flatMap(loaded, (view) =>
            Option.map(conversationOf(view), (conversation) => conversation.items),
          ),
        }),
      ),
      Effect.catch((detail) => Effect.succeed(Message.FailedLoadTranscript({ streamId, detail }))),
    ),
});
