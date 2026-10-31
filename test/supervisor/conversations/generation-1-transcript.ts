import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import {
  AgentEvent,
  AssistantMessage,
  type Entry,
  type PiMessage,
} from "../../../src/page/client/agent-event.js";

export function transcript(events: readonly AgentEvent[]): readonly Entry[] {
  const entries = new Map<number, Entry>();

  for (const event of events) {
    const ended =
      event.type === "snapshot"
        ? event.entries
        : (event.type === "message_end" ||
              event.type === "tool_execution_end" ||
              event.type === "entry_appended") &&
            event.entry !== undefined
          ? [event.entry]
          : [];

    for (const entry of ended) entries.set(entry.id, entry);
  }

  return [...entries.values()].toSorted((a, b) => a.id - b.id);
}

export type Line = Readonly<{ role: string; text: string }>;

const isAssistantMessage = Schema.is(AssistantMessage);

function messageText(message: PiMessage): string {
  if (!("content" in message)) return "";

  return Predicate.isString(message.content)
    ? message.content
    : message.content.flatMap((block) => ("text" in block ? [block.text] : [])).join("");
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

const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(AgentEvent));

export function readEvent(line: string): readonly AgentEvent[] {
  return Option.toArray(decodeEvent(line));
}
