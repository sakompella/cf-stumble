import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { defineTaggedUnion } from "foldkit/schema";
import type { AgentEvent as PiAgentEvent } from "@earendil-works/pi-durable";
import { AgentEvent } from "./agent-event.js";

type ReadTypes = AgentEvent["type"];

const READ_TYPES: ReadonlySet<string> = new Set<ReadTypes & PiAgentEvent["type"]>([
  "snapshot",
  "run_start",
  "run_end",
  "message_start",
  "message_update",
  "message_end",
  "entry_appended",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "inbox_update",
  "submission",
  "task_failed",
]);

export const EventLine = defineTaggedUnion({
  Event: { event: AgentEvent },
  Unread: {},
  Unreadable: {},
});

export type EventLine = typeof EventLine.Type;

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

const TypedLine = Schema.Struct({ type: Schema.String });

export function eventLine(line: string): EventLine {
  const maybeParsed = parseJson(line);
  const maybeTyped = Option.flatMap(maybeParsed, Schema.decodeUnknownOption(TypedLine));

  if (Option.isNone(maybeParsed) || Option.isNone(maybeTyped)) {
    return EventLine.Unreadable();
  }

  return Option.match(Schema.decodeUnknownOption(AgentEvent)(maybeParsed.value), {
    onNone: () =>
      READ_TYPES.has(maybeTyped.value.type) ? EventLine.Unreadable() : EventLine.Unread(),
    onSome: (event) => EventLine.Event({ event }),
  });
}
