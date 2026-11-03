import { applyImmutable, assertValidOp, type Op } from "@earendil-works/chord/delta";
import {
  ConversationTranscript,
  type ConversationView,
  type TranscriptView,
} from "@earendil-works/pi-durable";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { conversationOf, type Conversation } from "./conversation.js";

const parseLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.Json)));

function isConversationView(value: unknown): value is ConversationView {
  return (
    Predicate.isObject(value) &&
    "entries" in value &&
    Array.isArray(value.entries) &&
    "docs" in value &&
    Predicate.isObject(value.docs)
  );
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

export type HeldTranscript = {
  readonly transcript: ConversationTranscript;
  latest: TranscriptView | undefined;
};

export type ViewReader = (line: string) => Option.Option<Conversation>;

export function viewReader(held: HeldTranscript): ViewReader {
  let view: ConversationView | undefined;

  return (line) => {
    const maybeOps = parseLine(line);

    if (Option.isNone(maybeOps) || !isOps(maybeOps.value)) return Option.none();

    const maybeNext = applied(view, maybeOps.value);

    if (Option.isNone(maybeNext)) return Option.none();

    view = maybeNext.value;
    held.latest = held.transcript.merge(maybeNext.value);

    return conversationOf(held.latest);
  };
}

export function readFirstView(line: string): Option.Option<Conversation> {
  const transcript = new ConversationTranscript(() => Promise.reject(new Error("no history")));

  return viewReader({ transcript, latest: undefined })(line);
}
