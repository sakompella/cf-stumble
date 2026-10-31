import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { defineTaggedUnion } from "foldkit/schema";
import type { AgentEvent as PiAgentEvent } from "@earendil-works/pi-durable";

const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const ToolCallBlock = Schema.Struct({
  type: Schema.Literal("toolCall"),
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
});

const OtherBlock = Schema.Struct({ type: Schema.String });

export const Block = Schema.Union([TextBlock, ToolCallBlock, OtherBlock]);

export type Block = typeof Block.Type;

const Diagnostic = Schema.Struct({ type: Schema.String });

export const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(Block),
  stopReason: Schema.String,
  errorMessage: Schema.optionalKey(Schema.String),
  diagnostics: Schema.optionalKey(Schema.Array(Diagnostic)),
});

export type AssistantMessage = typeof AssistantMessage.Type;

const PiMessage = Schema.Union([
  Schema.Struct({
    role: Schema.Literal("user"),
    content: Schema.Union([Schema.String, Schema.Array(Block)]),
  }),
  AssistantMessage,
  Schema.Struct({
    role: Schema.Literal("toolResult"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    content: Schema.Array(Block),
    isError: Schema.Boolean,
  }),
  Schema.Struct({ role: Schema.String }),
]);

export type PiMessage = typeof PiMessage.Type;

export const Entry = Schema.Struct({
  id: Schema.Number,
  kind: Schema.String,
  model: Schema.optionalKey(Schema.Array(PiMessage)),
});

export type Entry = typeof Entry.Type;

const SubmissionIds = Schema.Array(Schema.Number);

export const ToolSlot = Schema.Struct({
  callId: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["pending", "running", "done"]),
  output: Schema.optionalKey(Schema.String),
});

export type ToolSlot = typeof ToolSlot.Type;

const QueuedItem = Schema.Struct({ id: Schema.Number });

const MessageChange = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["text_start", "thinking_start", "toolcall_start", "block"]),
    contentIndex: Schema.Number,
    block: Block,
  }),
  Schema.Struct({
    type: Schema.Literals(["text_delta", "thinking_delta", "toolcall_delta"]),
    contentIndex: Schema.Number,
    delta: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("message"), message: AssistantMessage }),
]);

export type MessageChange = typeof MessageChange.Type;

const ToolOutputChange = Schema.Union([
  Schema.Struct({ set: Schema.String }),
  Schema.Struct({
    trimStart: Schema.optionalKey(Schema.Number),
    append: Schema.optionalKey(Schema.String),
  }),
]);

export type ToolOutputChange = typeof ToolOutputChange.Type;

const toolCall = { toolCallId: Schema.String, toolName: Schema.String };

export const AgentEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    entries: Schema.Array(Entry),
    run: Schema.optionalKey(Schema.Struct({ inputs: SubmissionIds })),
    generation: Schema.optionalKey(
      Schema.Struct({ message: Schema.optionalKey(AssistantMessage) }),
    ),
    tools: Schema.Array(ToolSlot),
    inbox: Schema.Array(QueuedItem),
  }),
  Schema.Struct({ type: Schema.Literal("run_start"), inputs: SubmissionIds }),
  Schema.Struct({ type: Schema.Literal("run_end"), inputs: SubmissionIds }),
  Schema.Struct({ type: Schema.Literal("message_start"), message: PiMessage }),
  Schema.Struct({ type: Schema.Literal("message_update"), changes: Schema.Array(MessageChange) }),
  Schema.Struct({ type: Schema.Literal("message_end"), entry: Entry }),
  Schema.Struct({ type: Schema.Literal("entry_appended"), entry: Entry }),
  Schema.Struct({
    type: Schema.Literal("tool_execution_start"),
    ...toolCall,
    args: Schema.Record(Schema.String, Schema.Unknown),
  }),
  Schema.Struct({
    type: Schema.Literal("tool_execution_update"),
    ...toolCall,
    output: Schema.optionalKey(ToolOutputChange),
  }),
  Schema.Struct({
    type: Schema.Literal("tool_execution_end"),
    ...toolCall,
    entry: Schema.optionalKey(Entry),
  }),
  Schema.Struct({ type: Schema.Literal("inbox_update"), items: Schema.Array(QueuedItem) }),
  Schema.Struct({
    type: Schema.Literal("submission"),
    record: Schema.Struct({
      id: Schema.Number,
      requestId: Schema.optionalKey(Schema.String),
      status: Schema.String,
      reason: Schema.optionalKey(Schema.String),
    }),
  }),
  Schema.Struct({ type: Schema.Literal("task_failed"), message: Schema.String }),
]);

export type AgentEvent = typeof AgentEvent.Type;

type ReadTypes = AgentEvent["type"];

export const READ_EVENTS_ARE_PI_EVENTS: [ReadTypes] extends [PiAgentEvent["type"]] ? true : false =
  true;

const READ_TYPES: ReadonlySet<string> = new Set<ReadTypes>([
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

// oxlint-disable-next-line anti-slop/no-unknown-returns -- JSON.parse is where the event enters; the Schema below proves it.
const parseJson = Option.liftThrowable((raw: string): unknown => JSON.parse(raw));

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
