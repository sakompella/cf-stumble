import { normalizeContext } from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  Context,
  Message,
  SystemMessage,
  Tool,
} from "@earendil-works/pi-ai";
import { obj, str } from "@earendil-works/pi-schema";
import { expect, test } from "vitest";
import { transcriptToRouteRequest } from "../../../src/facet/generation-1/route-request.js";
import { ROUTE_MODEL } from "../../../src/facet/generation-1/route-provider.js";
import { NO_USAGE, replies, scriptedRoute, streamThroughProvider } from "./scripted-route.js";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

const TRANSCRIPT: Context = {
  systemPrompt: "You are a coder.",
  tools: [
    {
      name: "bash",
      description: "Run a command",
      parameters: obj({ cmd: str() }),
    },
  ],
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "Look: " },
        { type: "image", data: "AAA", mimeType: "image/png" },
      ],
      timestamp: 0,
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hm" },
        { type: "text", text: "Running." },
        { type: "toolCall", id: "call_1", name: "bash", arguments: { cmd: "ls" } },
      ],
      api: ROUTE_MODEL.api,
      provider: ROUTE_MODEL.provider,
      model: ROUTE_MODEL.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: ZERO_COST },
      stopReason: "toolUse",
      timestamp: 0,
    },
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "bash",
      content: [{ type: "text", text: "a.txt" }],
      isError: false,
      timestamp: 0,
    },
  ],
};

test("a transcript becomes one route request: system prompt, tools, tool results, images as text", async () => {
  const { capability, requests } = scriptedRoute(
    replies([
      {
        type: "done",
        served: { provider: "workers-ai", model: "test-model" },
        message: { role: "assistant", content: "", tool_calls: [] },
        usage: NO_USAGE,
      },
    ]),
  );

  await streamThroughProvider(capability, TRANSCRIPT).result();

  expect(requests).toEqual([
    {
      messages: [
        { role: "system", content: "You are a coder." },
        {
          role: "user",
          content: "Look: [Image omitted (image/png): this model route carries text only.]",
        },
        {
          role: "assistant",
          content: "Running.",
          tool_calls: [{ id: "call_1", function: { name: "bash", arguments: '{"cmd":"ls"}' } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "a.txt" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "bash",
            description: "Run a command",
            parameters: {
              type: "object",
              properties: { cmd: { type: "string" } },
              required: ["cmd"],
              additionalProperties: false,
            },
          },
        },
      ],
    },
  ]);
});

function systemMessage(
  fields: Omit<SystemMessage, "role" | "content" | "timestamp">,
): SystemMessage {
  return { role: "system", content: "", timestamp: 0, ...fields };
}

function user(text: string): Message {
  return { role: "user", content: text, timestamp: 0 };
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: text === "" ? [] : [{ type: "text", text }],
    api: ROUTE_MODEL.api,
    provider: ROUTE_MODEL.provider,
    model: ROUTE_MODEL.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: ZERO_COST },
    stopReason: "stop",
    timestamp: 0,
  };
}

function tool(name: string): Tool {
  return { name, description: `The ${name} tool.`, parameters: {} };
}

function contextOf(messages: readonly Message[]) {
  return normalizeContext({ messages: [...messages] });
}

test("the baseline leads and later system messages stay in place", () => {
  const request = transcriptToRouteRequest(
    contextOf([
      systemMessage({ sections: { preamble: "You are cf-stumble." } }),
      user("run the checks"),
      assistant("running"),
      systemMessage({ sections: { todo: "- fix the bug" } }),
      systemMessage({ sections: { todo: null } }),
      assistant("done"),
    ]),
  );

  expect(request).toEqual({
    messages: [
      { role: "system", content: "You are cf-stumble." },
      { role: "user", content: "run the checks" },
      { role: "assistant", content: "running", tool_calls: [] },
      { role: "system", content: 'Updated system prompt section "todo":\n\n- fix the bug' },
      { role: "system", content: 'Removed system prompt section "todo".' },
      { role: "assistant", content: "done", tool_calls: [] },
    ],
  });
});

test("a system message with no text of its own is dropped and tool changes ride the tool list", () => {
  const request = transcriptToRouteRequest(
    contextOf([
      systemMessage({ toolsAdded: [tool("read")] }),
      user("hi"),
      systemMessage({ toolsAdded: [tool("write")] }),
    ]),
  );

  expect(request).toEqual({
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        type: "function",
        function: { name: "read", description: "The read tool.", parameters: {} },
      },
      {
        type: "function",
        function: { name: "write", description: "The write tool.", parameters: {} },
      },
    ],
  });
});

test("a system message that does not lead is rendered as an update, not a new prompt", () => {
  const request = transcriptToRouteRequest(
    contextOf([assistant("earlier"), systemMessage({ sections: { preamble: "You are." } })]),
  );

  expect(request).toEqual({
    messages: [
      { role: "assistant", content: "earlier", tool_calls: [] },
      { role: "system", content: 'Updated system prompt section "preamble":\n\nYou are.' },
    ],
  });
});
