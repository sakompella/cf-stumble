import { ConversationTranscript } from "@earendil-works/pi-durable";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { Conversation } from "../../../src/page/client/conversation.js";
import {
  AssistantMessage,
  blocksText,
  type Entry,
  type PiMessage,
} from "../../../src/page/client/pi-message.js";
import { viewReader } from "../../../src/page/client/view-reader.js";

export function openReader() {
  const transcript = new ConversationTranscript(() => Promise.reject(new Error("no history")));
  const read = viewReader({ transcript, latest: undefined });
  let latest = Option.none<Conversation>();

  return {
    feed: (line: string) => {
      latest = read(line);
    },
    isRunning: () => Option.exists(latest, (value) => value.isRunning),
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
