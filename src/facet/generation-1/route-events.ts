import {
  arr,
  bool,
  compile,
  lit,
  nul,
  num,
  obj,
  oneOf,
  opt,
  str,
  union,
} from "@earendil-works/pi-schema";
import type { ModelStreamEvent } from "../../model-route-wire/events.js";

const ToolCallDeltaSchema = obj(
  {
    index: num(),
    id: opt(str()),
    name: opt(str()),
    argumentsDelta: opt(str()),
  },
  { open: true },
);

const ToolCallSchema = obj(
  {
    id: str(),
    function: obj({ name: str(), arguments: str() }, { open: true }),
  },
  { open: true },
);

const AssistantMessageSchema = obj(
  {
    role: lit("assistant"),
    content: union([str(), nul()]),
    tool_calls: arr(ToolCallSchema),
  },
  { open: true },
);

const UsageSchema = obj(
  { inputTokens: num(), outputTokens: num(), estimated: bool() },
  { open: true },
);

const ModelStreamEventSchema = union([
  obj({ type: lit("text-delta"), delta: str() }, { open: true }),
  obj({ type: lit("tool-call-delta"), delta: ToolCallDeltaSchema }, { open: true }),
  obj(
    {
      type: lit("done"),
      message: AssistantMessageSchema,
      usage: UsageSchema,
      truncated: opt(lit(true)),
    },
    { open: true },
  ),
  obj(
    {
      type: lit("error"),
      error: obj(
        { code: oneOf(["model-unavailable", "chatgpt-reconnect-required"]), detail: opt(str()) },
        { open: true },
      ),
    },
    { open: true },
  ),
  obj(
    {
      type: lit("provider-fallback"),
      reason: lit("chatgpt-usage-limit"),
      limitedUntil: union([num(), nul()]),
    },
    { open: true },
  ),
]);

const checkModelStreamEvent = compile(ModelStreamEventSchema).check;

export function isModelStreamEvent(value: unknown): value is ModelStreamEvent {
  return checkModelStreamEvent(value);
}
