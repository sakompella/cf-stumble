import * as Schema from "effect/Schema";

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

const Diagnostic = Schema.Struct({
  type: Schema.String,
  details: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

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

export const ToolSlot = Schema.Struct({
  callId: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["pending", "running", "done"]),
  output: Schema.optionalKey(Schema.String),
});

export type ToolSlot = typeof ToolSlot.Type;

export function blocksText(blocks: readonly Block[]): string {
  return blocks.flatMap((block) => ("text" in block ? [block.text] : [])).join("");
}
