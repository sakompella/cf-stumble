import { expect, test } from "vitest";
import {
  MODEL,
  validateRequest,
  buildProviderPayload,
  normalizeResponse,
  invokeModel,
  type ModelRouteRequest,
  type ModelRouteResponse,
  type AssistantMessage,
  type ModelInference,
  type ValidationFailure,
} from "../src/model-route.js";

test("processes a multi-turn request with tool calls and tool results", async () => {
  const tcId = "call_abc123";
  const request: ModelRouteRequest = {
    messages: [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "Read file.txt" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: tcId, function: { name: "read_file", arguments: '{"path":"file.txt"}' } },
        ],
      },
      { role: "tool", tool_call_id: tcId, content: "file contents here" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ],
  };
  const calls: Array<{ model: string; input: unknown }> = [];
  const ai: ModelInference = {
    run(model, input) {
      calls.push({ model, input });
      return Promise.resolve({ response: "Here are the file contents." });
    },
  };
  const result = await invokeModel(ai, request);
  expect(result).toEqual({
    ok: true,
    message: {
      role: "assistant",
      content: "Here are the file contents.",
      tool_calls: [],
    },
  } satisfies ModelRouteResponse);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.model).toBe(MODEL);
});

test("builds provider payload with fixed model and low reasoning effort", () => {
  const request: ModelRouteRequest = {
    messages: [
      { role: "system", content: "System" },
      { role: "user", content: "Hello" },
    ],
  };
  expect(buildProviderPayload(request)).toEqual({
    messages: [
      { role: "system", content: "System" },
      { role: "user", content: "Hello" },
    ],
    reasoning_effort: "low",
    max_tokens: 4096,
  });
});

test("includes tools in the provider payload when present", () => {
  const request: ModelRouteRequest = {
    messages: [{ role: "user", content: "Hello" }],
    tools: [
      {
        type: "function",
        function: { name: "g", description: "G", parameters: {} },
      },
    ],
  };
  expect(buildProviderPayload(request)).toHaveProperty("tools");
  expect(buildProviderPayload(request)).toHaveProperty("max_tokens", 4096);
});

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

test("rejects malformed tool call: missing id", () => {
  const r = validateRequest({
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ function: { name: "r", arguments: "{}" } }],
      },
    ],
  });
  expect(r).toEqual({
    ok: false,
    error: {
      code: "invalid-request",
      reason: "tool_calls[0] at messages[0] missing non-empty id",
    },
  } satisfies ValidationFailure);
});

test("rejects tool call missing function.name", () => {
  const r = validateRequest({
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", function: { arguments: "{}" } }],
      },
    ],
  });
  expect(r).toEqual({
    ok: false,
    error: {
      code: "invalid-request",
      reason: "tool_calls[0] at messages[0] missing function.name",
    },
  } satisfies ValidationFailure);
});

test("rejects tool call missing function.arguments", () => {
  const r = validateRequest({
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", function: { name: "r" } }],
      },
    ],
  });
  expect(r).toEqual({
    ok: false,
    error: {
      code: "invalid-request",
      reason: "tool_calls[0] at messages[0] missing function.arguments",
    },
  } satisfies ValidationFailure);
});

test("rejects oversized input exceeding 1 MiB", () => {
  const r = validateRequest({
    messages: [{ role: "user", content: "x".repeat(2_000_000) }],
  });
  expect(r).toEqual({
    ok: false,
    error: { code: "invalid-request", reason: "request exceeds 1 MiB size limit" },
  } satisfies ValidationFailure);
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

test("rejects a request with no messages", () => {
  expect(validateRequest({})).toEqual({
    ok: false,
    error: { code: "invalid-request", reason: "messages must be a non-empty array" },
  } satisfies ValidationFailure);
});

test("rejects empty messages array", () => {
  expect(validateRequest({ messages: [] })).toEqual({
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

test("redacts inference failures to a stable safe error", async () => {
  const ai: ModelInference = {
    run() {
      return Promise.reject(new Error("provider secret leaked"));
    },
  };
  const r = await invokeModel(ai, { messages: [{ role: "user", content: "Hi" }] });
  expect(r).toEqual({
    ok: false,
    error: { code: "model-unavailable" },
  } satisfies ModelRouteResponse);
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
