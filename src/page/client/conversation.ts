import * as Array from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AssistantMessage,
  Entry,
  ToolSlot,
  type AgentEvent,
  type Block,
  type MessageChange,
  type ToolOutputChange,
} from "./events.js";

export const Conversation = Schema.Struct({
  entries: Schema.Array(Entry),
  maybePartial: Schema.Option(AssistantMessage),
  tools: Schema.Array(ToolSlot),
  isRunning: Schema.Boolean,
  inbox: Schema.Array(Schema.Number),
});

export type Conversation = typeof Conversation.Type;

export const EMPTY_CONVERSATION: Conversation = {
  entries: [],
  maybePartial: Option.none(),
  tools: [],
  isRunning: false,
  inbox: [],
};

function withEntry(conversation: Conversation, entry: Entry): Conversation {
  const isNew = Option.match(Array.last(conversation.entries), {
    onNone: () => true,
    onSome: (last) => entry.id > last.id,
  });

  return isNew ? { ...conversation, entries: [...conversation.entries, entry] } : conversation;
}

function changedBlock(maybeBlock: Block | undefined, delta: string): Block | undefined {
  if (maybeBlock?.type === "text" && "text" in maybeBlock) {
    return { ...maybeBlock, text: `${maybeBlock.text}${delta}` };
  }

  return maybeBlock;
}

function withChange(message: AssistantMessage, change: MessageChange): AssistantMessage {
  if (change.type === "message") {
    return change.message;
  }

  const content = [...message.content];
  const current = content[change.contentIndex];
  const next = "block" in change ? change.block : changedBlock(current, change.delta);

  if (next === undefined) {
    return message;
  }

  content[change.contentIndex] = next;

  return { ...message, content };
}

function withOutput(output: string | undefined, change: ToolOutputChange): string {
  if ("set" in change) {
    return change.set;
  }

  return `${(output ?? "").slice(change.trimStart ?? 0)}${change.append ?? ""}`;
}

function withTool(
  conversation: Conversation,
  callId: string,
  change: (slot: ToolSlot) => ToolSlot,
): Conversation {
  return {
    ...conversation,
    tools: conversation.tools.map((slot) => (slot.callId === callId ? change(slot) : slot)),
  };
}

function withMessage(conversation: Conversation, event: MessageEvent): Conversation {
  return Match.value(event).pipe(
    Match.discriminatorsExhaustive("type")({
      message_start: ({ message }) =>
        Schema.is(AssistantMessage)(message)
          ? { ...conversation, maybePartial: Option.some(message) }
          : conversation,
      message_update: ({ changes }) => ({
        ...conversation,
        maybePartial: Option.map(conversation.maybePartial, (partial) =>
          changes.reduce(withChange, partial),
        ),
      }),
      message_end: ({ entry }) => withEndedMessage(conversation, entry),
      entry_appended: ({ entry }) => withEndedMessage(conversation, entry),
    }),
  );
}

function withEndedMessage(conversation: Conversation, entry: Entry): Conversation {
  const appended = withEntry(conversation, entry);
  const isAnswer = entry.model?.some((message) => Schema.is(AssistantMessage)(message)) === true;

  return isAnswer ? { ...appended, maybePartial: Option.none() } : appended;
}

function withToolEvent(conversation: Conversation, event: ToolEvent): Conversation {
  return Match.value(event).pipe(
    Match.discriminatorsExhaustive("type")({
      tool_execution_start: ({ toolCallId, toolName }) => ({
        ...conversation,
        tools: [
          ...conversation.tools.filter((slot) => slot.callId !== toolCallId),
          { callId: toolCallId, name: toolName, status: "running" as const },
        ],
      }),
      tool_execution_update: ({ toolCallId, output }) =>
        output === undefined
          ? conversation
          : withTool(conversation, toolCallId, (slot) => ({
              ...slot,
              output: withOutput(slot.output, output),
            })),
      tool_execution_end: ({ toolCallId, entry }) => {
        const ended = withTool(conversation, toolCallId, (slot) => ({ ...slot, status: "done" }));

        return entry === undefined ? ended : withEntry(ended, entry);
      },
    }),
  );
}

type MessageEvent = Extract<
  AgentEvent,
  Readonly<{ type: "message_start" | "message_update" | "message_end" | "entry_appended" }>
>;

type ToolEvent = Extract<
  AgentEvent,
  Readonly<{ type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }>
>;

export function applyEvent(conversation: Conversation, event: AgentEvent): Conversation {
  return Match.value(event).pipe(
    Match.discriminatorsExhaustive("type")({
      snapshot: (snapshot) => ({
        entries: snapshot.entries,
        maybePartial: Option.fromUndefinedOr(snapshot.generation?.message),
        tools: snapshot.tools,
        isRunning: snapshot.run !== undefined,
        inbox: snapshot.inbox.map((item) => item.id),
      }),
      run_start: () => ({ ...conversation, isRunning: true }),
      run_end: () => ({
        ...conversation,
        isRunning: false,
        maybePartial: Option.none(),
        tools: [],
      }),
      message_start: (message) => withMessage(conversation, message),
      message_update: (message) => withMessage(conversation, message),
      message_end: (message) => withMessage(conversation, message),
      entry_appended: (message) => withMessage(conversation, message),
      tool_execution_start: (tool) => withToolEvent(conversation, tool),
      tool_execution_update: (tool) => withToolEvent(conversation, tool),
      tool_execution_end: (tool) => withToolEvent(conversation, tool),
      inbox_update: ({ items }) => ({ ...conversation, inbox: items.map((item) => item.id) }),
      submission: () => conversation,
      task_failed: () => conversation,
    }),
  );
}
