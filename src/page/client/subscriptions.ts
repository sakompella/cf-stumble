import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Dom, Subscription } from "foldkit";
import { eventsOf } from "./events-stream.js";
import { FreshThread } from "./fresh-thread.js";
import { Message } from "./message.js";
import type { Model } from "./model.js";
import {
  MaybeTranscriptKey,
  streamableTranscript,
  type TranscriptService,
} from "./transcript-store.js";

const FRESH_THREAD_CONFIRMATION = "10 seconds";

const connectivity = Stream.merge(
  Dom.streamFromEvent({
    target: () => window,
    type: "online",
    mapEvent: () => Message.ChangedConnectivity({ isOnline: true }),
  }),
  Dom.streamFromEvent({
    target: () => window,
    type: "offline",
    mapEvent: () => Message.ChangedConnectivity({ isOnline: false }),
  }),
);

export const subscriptions = Subscription.make<Model, Message, TranscriptService>()((entry) => ({
  connectivity: Subscription.persistentEntry(connectivity),
  freshThreadExpiry: entry(
    { isArmed: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ isArmed: FreshThread.guards.Armed(model.freshThread) }),
      dependenciesToStream: ({ isArmed }) =>
        isArmed
          ? Stream.fromEffect(
              Effect.sleep(FRESH_THREAD_CONFIRMATION).pipe(Effect.as(Message.ExpiredFreshThread())),
            )
          : Stream.empty,
    },
  ),
  events: entry(
    { maybeStream: MaybeTranscriptKey },
    {
      modelToDependencies: (model) => ({ maybeStream: streamableTranscript(model) }),
      dependenciesToStream: ({ maybeStream }) =>
        Option.match(maybeStream, {
          onNone: () => Stream.empty,
          onSome: eventsOf,
        }),
    },
  ),
}));
