import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { TranscriptView } from "@earendil-works/pi-durable";
import { AssistantMessage, Block, blocksText, Entry, ToolSlot } from "./pi-message.js";
import { RunPhase, runPhaseOf } from "./run-phase.js";

const ViewItem = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("entry"), entry: Entry }),
  Schema.Struct({ kind: Schema.Literal("gap"), after: Schema.Number, upTo: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("earlier") }),
]);

type ViewItem = typeof ViewItem.Type;

const LiveDoc = Schema.Struct({
  run: Schema.optionalKey(
    Schema.Struct({
      inputs: Schema.Array(Schema.Number),
      afterRun: Schema.optionalKey(Schema.Struct({})),
    }),
  ),
  generation: Schema.optionalKey(Schema.Struct({ message: Schema.optionalKey(AssistantMessage) })),
  tools: Schema.optionalKey(Schema.Array(ToolSlot)),
  compactions: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  runFailure: Schema.optionalKey(Schema.Struct({ reason: Schema.String })),
});

const InboxDoc = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      content: Schema.Union([Schema.String, Schema.Array(Block)]),
    }),
  ),
});

const TranscriptDoc = Schema.Struct({
  conversation: Schema.Struct({ id: Schema.Number }),
  items: Schema.Array(ViewItem),
  docs: Schema.Struct({
    "pi.live": Schema.optionalKey(LiveDoc),
    "pi.inbox": Schema.optionalKey(InboxDoc),
  }),
});

const QueuedInput = Schema.Struct({ id: Schema.Number, text: Schema.String });

export const Conversation = Schema.Struct({
  maybeId: Schema.Option(Schema.Number),
  items: Schema.Array(ViewItem),
  maybePartial: Schema.Option(AssistantMessage),
  tools: Schema.Array(ToolSlot),
  run: RunPhase,
  maybeRunFailure: Schema.Option(Schema.String),
  inbox: Schema.Array(QueuedInput),
});

export type Conversation = typeof Conversation.Type;

export const EMPTY_CONVERSATION: Conversation = {
  maybeId: Option.none(),
  items: [],
  maybePartial: Option.none(),
  tools: [],
  run: "Idle",
  maybeRunFailure: Option.none(),
  inbox: [],
};

export function conversationOf(view: TranscriptView): Option.Option<Conversation> {
  return Option.map(Schema.decodeOption(TranscriptDoc)(view), ({ conversation, items, docs }) => ({
    maybeId: Option.some(conversation.id),
    items,
    maybePartial: Option.fromUndefinedOr(docs["pi.live"]?.generation?.message),
    tools: docs["pi.live"]?.tools ?? [],
    run: runPhaseOf(docs["pi.live"]),
    maybeRunFailure: Option.fromUndefinedOr(docs["pi.live"]?.runFailure?.reason),
    inbox: (docs["pi.inbox"]?.items ?? []).map(({ id, content }) => ({
      id,
      text: Predicate.isString(content) ? content : blocksText(content),
    })),
  }));
}

export function isRunning(conversation: Conversation): boolean {
  return conversation.run !== "Idle";
}

export function newestEntryId(conversation: Conversation): number {
  return conversation.items.reduce(
    (newest, item) => (item.kind === "entry" ? Math.max(newest, item.entry.id) : newest),
    0,
  );
}
