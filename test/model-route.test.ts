import { expect, test } from "vitest";
import { normalizeResponse } from "../src/model-route-stream.js";
import {
  validateRequest,
  type AssistantMessage,
  type ValidationFailure,
} from "../src/model-route.js";

test("rejects a message with an unknown role", () => {
  const r = validateRequest({
    messages: [
      { role: "user", content: "Hi" },
      { role: "function", content: "bad" },
    ],
  });

  expect(r).toEqual({
    ok: false,
    error: { code: "invalid-request", reason: 'unknown role "function" at messages[1]' },
  } satisfies ValidationFailure);
});

test("rejects a tool-result message without tool_call_id", () => {
  const r = validateRequest({ messages: [{ role: "tool", content: "result" }] });
  expect(r).toEqual({
    ok: false,
    error: {
      code: "invalid-request",
      reason: "tool message at messages[0] missing non-empty tool_call_id",
    },
  } satisfies ValidationFailure);
});

test.each([
  {
    name: "missing id",
    request: {
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ function: { name: "r", arguments: "{}" } }],
        },
      ],
    },
    reason: "tool_calls[0] at messages[0] missing non-empty id",
  },
  {
    name: "missing function.name",
    request: {
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", function: { arguments: "{}" } }],
        },
      ],
    },
    reason: "tool_calls[0] at messages[0] missing function.name",
  },
  {
    name: "missing function.arguments",
    request: {
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", function: { name: "r" } }],
        },
      ],
    },
    reason: "tool_calls[0] at messages[0] missing function.arguments",
  },
])("rejects a tool call with $name", ({ request, reason }) => {
  expect(validateRequest(request)).toEqual({
    ok: false,
    error: { code: "invalid-request", reason },
  } satisfies ValidationFailure);
});

test("rejects a request whose UTF-8 byte size exceeds 1 MiB even though its string length does not", () => {
  const content = "\u00E9".repeat(600_000);
  expect(content.length).toBeLessThan(1_048_576);
  expect(validateRequest({ messages: [{ role: "user", content }] })).toEqual({
    ok: false,
    error: { code: "invalid-request", reason: "request exceeds 1 MiB size limit" },
  } satisfies ValidationFailure);
});

test("accepts a request comfortably under the byte-size limit even with multi-byte characters", () => {
  const content = "\u00E9".repeat(1_000);
  expect(validateRequest({ messages: [{ role: "user", content }] })).toEqual({ ok: true });
});

test.each(["model", "reasoning_effort", "credentials", "endpoint", "provider"] as const)(
  "rejects a request that includes %s",
  (field) => {
    const r = validateRequest({
      messages: [{ role: "user", content: "Hi" }],
      [field]: "forbidden",
    });

    expect(r).toEqual({
      ok: false,
      error: {
        code: "invalid-request",
        reason: `request must not include provider field: ${field}`,
      },
    } satisfies ValidationFailure);
  },
);

test.each([
  { name: "no messages", request: {} },
  { name: "an empty messages array", request: { messages: [] } },
])("rejects a request with $name", ({ request }) => {
  expect(validateRequest(request)).toEqual({
    ok: false,
    error: { code: "invalid-request", reason: "messages must be a non-empty array" },
  } satisfies ValidationFailure);
});

test("normalizes a plain text response", () => {
  expect(normalizeResponse({ response: "Hello" })).toEqual({
    role: "assistant",
    content: "Hello",
    tool_calls: [],
  } satisfies AssistantMessage);
});

test("normalizes a response with tool calls", () => {
  expect(
    normalizeResponse({
      response: null,
      tool_calls: [{ id: "c1", function: { name: "read", arguments: '{"p":"a"}' } }],
    }),
  ).toEqual({
    role: "assistant",
    content: null,
    tool_calls: [{ id: "c1", function: { name: "read", arguments: '{"p":"a"}' } }],
  } satisfies AssistantMessage);
});

test("validates a correct simple request", () => {
  expect(
    validateRequest({
      messages: [
        { role: "system", content: "Be helpful" },
        { role: "user", content: "Hi" },
      ],
    }),
  ).toEqual({ ok: true });
});

test("validates a request with all four message roles", () => {
  expect(
    validateRequest({
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "R" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", function: { name: "r", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: "ok" },
      ],
    }),
  ).toEqual({ ok: true });
});

test("rejects non-object entry in messages", () => {
  expect(validateRequest({ messages: ["not a message"] })).toEqual({
    ok: false,
    error: { code: "invalid-request", reason: "messages[0] is not an object" },
  } satisfies ValidationFailure);
});

test("rejects assistant content that is neither string nor null", () => {
  expect(validateRequest({ messages: [{ role: "assistant", content: 42 }] })).toEqual({
    ok: false,
    error: {
      code: "invalid-request",
      reason: "assistant message at messages[0] content must be string or null",
    },
  } satisfies ValidationFailure);
});
