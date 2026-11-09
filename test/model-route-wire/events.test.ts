import { expect, test } from "vitest";
import { isModelStreamEvent } from "../../src/model-route-wire/events.js";

const ASSISTANT = { role: "assistant", content: null, tool_calls: [] } as const;

const USAGE = { inputTokens: 3, outputTokens: 5, estimated: false } as const;

const VALID: readonly unknown[] = [
  { type: "text-delta", delta: "hi" },
  { type: "tool-call-delta", delta: { index: 0 } },
  { type: "tool-call-delta", delta: { index: 1, id: "c", name: "n", argumentsDelta: "{}" } },
  { type: "done", message: ASSISTANT, usage: USAGE },
  { type: "done", message: ASSISTANT, usage: USAGE, truncated: true },
  { type: "error", error: { code: "model-unavailable" } },
  { type: "error", error: { code: "chatgpt-reconnect-required", detail: "expired" } },
  { type: "provider-fallback", reason: "chatgpt-usage-limit", limitedUntil: null },
  { type: "provider-fallback", reason: "chatgpt-usage-limit", limitedUntil: 123 },
];

const MALFORMED: readonly unknown[] = [
  {},
  null,
  { type: "unknown-tag" },
  { type: "text-delta" },
  { type: "text-delta", delta: 42 },
  { type: "tool-call-delta", delta: { index: 0, id: 42 } },
  { type: "tool-call-delta", delta: { index: "0" } },
  { type: "done" },
  { type: "done", message: ASSISTANT },
  { type: "done", message: { role: "assistant", content: "text" }, usage: USAGE },
  {
    type: "done",
    message: { role: "assistant", content: null, tool_calls: [{ id: "", function: {} }] },
    usage: USAGE,
  },
  { type: "done", message: ASSISTANT, usage: { inputTokens: 3, outputTokens: 5 } },
  { type: "done", message: ASSISTANT, usage: USAGE, truncated: "yes" },
  { type: "error" },
  { type: "error", error: {} },
  { type: "error", error: { code: "not-a-route-code" } },
  { type: "error", error: { code: "model-unavailable", detail: 42 } },
  { type: "provider-fallback", reason: "chatgpt-usage-limit" },
  { type: "provider-fallback", reason: "other", limitedUntil: null },
  { type: "provider-fallback", reason: "chatgpt-usage-limit", limitedUntil: "soon" },
];

test("accepts each well-formed event variant", () => {
  for (const event of VALID) expect(isModelStreamEvent(event), JSON.stringify(event)).toBe(true);
});

test("rejects an event whose tag is known but whose fields are missing or wrong", () => {
  for (const event of MALFORMED)
    expect(isModelStreamEvent(event), JSON.stringify(event)).toBe(false);
});
