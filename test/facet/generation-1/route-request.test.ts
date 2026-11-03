import { obj, str } from "@earendil-works/pi-schema";
import type { Context } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
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
