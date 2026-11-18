import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { isRunning, type Conversation } from "../../../src/conversation-view/conversation.js";
import {
  AssistantMessage,
  blocksText,
  type Entry,
  type PiMessage,
} from "../../../src/conversation-view/pi-message.js";
import { freshViewReader } from "../../../src/conversation-view/view-reader.js";

export function openReader() {
  const read = freshViewReader();

  let latest = Option.none<Conversation>();

  return {
    feed: (line: string) => {
      latest = read(line);
    },
    viewed: () => Option.isSome(latest),
    conversationId: () =>
      String(Option.getOrThrow(Option.flatMap(latest, ({ maybeId }) => maybeId))),
    phase: () => Option.match(latest, { onNone: () => "unread", onSome: ({ run }) => run }),
    isRunning: () => Option.exists(latest, isRunning),
    entries: (): readonly Entry[] =>
      Option.match(latest, {
        onNone: () => [],
        onSome: ({ items }) => items.flatMap((item) => (item.kind === "entry" ? [item.entry] : [])),
      }),
  };
}

export type Line = Readonly<{ role: string; text: string }>;

const isAssistantMessage = Schema.is(AssistantMessage);

function messageText(message: PiMessage): string {
  if (!("content" in message)) return "";

  return Predicate.isString(message.content) ? message.content : blocksText(message.content);
}

export function lines(entries: readonly Entry[]): readonly Line[] {
  return entries.flatMap((entry) =>
    (entry.model ?? [])
      .filter((message) => message.role !== "system")
      .map((message) => ({ role: message.role, text: messageText(message) })),
  );
}

export function answerCount(entries: readonly Entry[]): number {
  return entries.filter((entry) =>
    (entry.model ?? []).some(
      (message) => isAssistantMessage(message) && message.stopReason === "stop",
    ),
  ).length;
}
