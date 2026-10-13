import * as Result from "effect/Result";
import { expect, test } from "vitest";
import { normalizeResponse } from "../src/model-route-stream.js";
import {
  parseRequest,
  type AssistantMessage,
  type ModelRouteRequest,
  type ValidationFailure,
} from "../src/model-route.js";

function rejected(reason: string): Result.Result<ModelRouteRequest, ValidationFailure> {
  return Result.fail({ ok: false, error: { code: "invalid-request", reason } });
}

const USER = { role: "user", content: "Hi" } as const;

const READ_TOOL = {
  type: "function",
  function: { name: "read", description: "Read a file", parameters: { type: "object" } },
} as const;

test("rejects a message with an unknown role", () => {
  expect(
    parseRequest({
      messages: [
        { role: "user", content: "Hi" },
        { role: "function", content: "bad" },
      ],
    }),
  ).toEqual(rejected('unknown role "function" at messages[1]'));
});

test("rejects a tool-result message without tool_call_id", () => {
  expect(parseRequest({ messages: [{ role: "tool", content: "result" }] })).toEqual(
    rejected("tool message at messages[0] missing non-empty tool_call_id"),
  );
});

test.each([
  {
    name: "missing id",
    toolCall: { function: { name: "r", arguments: "{}" } },
    reason: "tool_calls[0] at messages[0] missing non-empty id",
  },
  {
    name: "missing function.name",
    toolCall: { id: "c1", function: { arguments: "{}" } },
    reason: "tool_calls[0] at messages[0] missing function.name",
  },
  {
    name: "missing function.arguments",
    toolCall: { id: "c1", function: { name: "r" } },
    reason: "tool_calls[0] at messages[0] missing function.arguments",
  },
])("rejects a tool call with $name", ({ toolCall, reason }) => {
  expect(
    parseRequest({ messages: [{ role: "assistant", content: null, tool_calls: [toolCall] }] }),
  ).toEqual(rejected(reason));
});

test("rejects a request whose UTF-8 byte size exceeds 1 MiB even though its string length does not", () => {
  const content = "\u00E9".repeat(600_000);
  expect(content.length).toBeLessThan(1_048_576);
  expect(parseRequest({ messages: [{ role: "user", content }] })).toEqual(
    rejected("request exceeds 1 MiB size limit"),
  );
});

test("accepts a request comfortably under the byte-size limit even with multi-byte characters", () => {
  const content = "\u00E9".repeat(1_000);
  expect(parseRequest({ messages: [{ role: "user", content }] })).toEqual(
    Result.succeed({ messages: [{ role: "user", content }] }),
  );
});

test.each(["model", "reasoning_effort", "credentials", "endpoint", "provider"] as const)(
  "rejects a request that includes %s",
  (field) => {
    expect(parseRequest({ messages: [USER], [field]: "forbidden" })).toEqual(
      rejected(`request must not include provider field: ${field}`),
    );
  },
);

test.each([
  { name: "no messages", request: {} },
  { name: "an empty messages array", request: { messages: [] } },
])("rejects a request with $name", ({ request }) => {
  expect(parseRequest(request)).toEqual(rejected("messages must be a non-empty array"));
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

test("parses a request with all four message roles and a tool to the same request", () => {
  const request: ModelRouteRequest = {
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
    tools: [READ_TOOL],
  };

  expect(parseRequest(request)).toEqual(Result.succeed(request));
});

test("an assistant message without tool_calls parses with none, and fields the route does not know are dropped", () => {
  expect(
    parseRequest({
      messages: [
        { role: "user", content: "Hi", name: "owner" },
        { role: "assistant", content: "Hello" },
      ],
      tools: [{ ...READ_TOOL, strict: true }],
    }),
  ).toEqual(
    Result.succeed({
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello", tool_calls: [] },
      ],
      tools: [READ_TOOL],
    }),
  );
});

test("rejects non-object entry in messages", () => {
  expect(parseRequest({ messages: ["not a message"] })).toEqual(
    rejected("messages[0] is not an object"),
  );
});

test("rejects assistant content that is neither string nor null", () => {
  expect(parseRequest({ messages: [{ role: "assistant", content: 42 }] })).toEqual(
    rejected("assistant message at messages[0] content must be string or null"),
  );
});

test.each([
  { name: "absent", fields: {}, parsed: {} },
  { name: "empty", fields: { tools: [] }, parsed: { tools: [] } },
  { name: "one valid tool", fields: { tools: [READ_TOOL] }, parsed: { tools: [READ_TOOL] } },
])("accepts tools that are $name", ({ fields, parsed }) => {
  expect(parseRequest({ messages: [USER], ...fields })).toEqual(
    Result.succeed({ messages: [USER], ...parsed }),
  );
});

const readFunction = READ_TOOL.function;

test.each([
  { tools: 42, reason: "tools must be an array" },
  { tools: "read", reason: "tools must be an array" },
  { tools: null, reason: "tools must be an array" },
  { tools: { 0: READ_TOOL }, reason: "tools must be an array" },
  { tools: [42], reason: "tools[0] is not an object" },
  { tools: [READ_TOOL, [READ_TOOL]], reason: "tools[1] is not an object" },
  { tools: [{ function: readFunction }], reason: 'tools[0] type must be "function"' },
  { tools: [{ type: "web_search" }], reason: 'tools[0] type must be "function"' },
  { tools: [{ type: "function" }], reason: "tools[0] missing function" },
  { tools: [{ type: "function", function: "read" }], reason: "tools[0] missing function" },
  {
    tools: [{ type: "function", function: { ...readFunction, name: "" } }],
    reason: "tools[0] missing function.name",
  },
  {
    tools: [{ type: "function", function: { ...readFunction, name: 7 } }],
    reason: "tools[0] missing function.name",
  },
  {
    tools: [{ type: "function", function: { name: "read", parameters: {} } }],
    reason: "tools[0] function.description must be a string",
  },
  {
    tools: [{ type: "function", function: { name: "read", description: "d" } }],
    reason: "tools[0] function.parameters must be an object",
  },
  {
    tools: [{ type: "function", function: { ...readFunction, parameters: null } }],
    reason: "tools[0] function.parameters must be an object",
  },
  {
    tools: [{ type: "function", function: { ...readFunction, parameters: [] } }],
    reason: "tools[0] function.parameters must be an object",
  },
  {
    tools: [{ type: "function", function: { ...readFunction, parameters: "{}" } }],
    reason: "tools[0] function.parameters must be an object",
  },
])("rejects tools $tools", ({ tools, reason }) => {
  expect(parseRequest({ messages: [USER], tools })).toEqual(rejected(reason));
});
