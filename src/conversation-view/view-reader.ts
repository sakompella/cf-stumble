import { applyImmutable, assertValidOp, type Op } from "@earendil-works/chord/delta";
import {
  ConversationTranscript,
  type ConversationView,
  type EntryLoader,
  type TranscriptView,
} from "@earendil-works/pi-durable";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { conversationOf, type Conversation } from "./conversation.js";

const parseLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.Json)));

const hasViewFields = Schema.is(
  Schema.Struct({
    entries: Schema.Array(Schema.Unknown),
    docs: Schema.Record(Schema.String, Schema.Unknown),
  }),
);

function isConversationView(value: unknown): value is ConversationView {
  return hasViewFields(value);
}

function isOps(value: readonly unknown[]): value is readonly Op[] {
  try {
    value.forEach((op) => {
      assertValidOp(op);
    });

    return true;
  } catch {
    return false;
  }
}

function applied(
  view: ConversationView | undefined,
  ops: readonly Op[],
): Option.Option<ConversationView> {
  try {
    const next: unknown = applyImmutable(view, ops);

    return isConversationView(next) ? Option.some(next) : Option.none();
  } catch {
    return Option.none();
  }
}

export const TranscriptKey = Schema.Struct({ streamId: Schema.Number, projectId: Schema.String });

export type TranscriptKey = typeof TranscriptKey.Type;

export type HeldTranscript = {
  readonly key: TranscriptKey;
  readonly load: EntryLoader;
  transcript: ConversationTranscript;
  conversationId: number | undefined;
  latest: TranscriptView | undefined;
};

export function heldTranscript(key: TranscriptKey, load: EntryLoader): HeldTranscript {
  return {
    key,
    load,
    transcript: new ConversationTranscript(load),
    conversationId: undefined,
    latest: undefined,
  };
}

export type ViewReader = (line: string) => Option.Option<Conversation>;

export function viewReader(held: HeldTranscript): ViewReader {
  let view: ConversationView | undefined;

  return (line) => {
    const maybeOps = parseLine(line);

    if (Option.isNone(maybeOps) || !isOps(maybeOps.value)) return Option.none();

    const maybeNext = applied(view, maybeOps.value);

    if (Option.isNone(maybeNext)) return Option.none();

    view = maybeNext.value;

    if (held.conversationId !== undefined && held.conversationId !== view.conversation.id) {
      held.transcript = new ConversationTranscript(held.load);
    }

    held.conversationId = view.conversation.id;
    held.latest = held.transcript.merge(maybeNext.value);

    return conversationOf(held.latest);
  };
}

export function freshViewReader(): ViewReader {
  return viewReader(
    heldTranscript({ streamId: 0, projectId: "" }, () => Promise.reject(new Error("no history"))),
  );
}

export function readView(line: string): Option.Option<Conversation> {
  return freshViewReader()(line);
}
