import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { normalizeContext } from "@earendil-works/pi-ai";
import { obj, str } from "@earendil-works/pi-schema";
import type {
  AssistantMessage,
  Context,
  ImageContent,
  JsonObject,
  Message,
  TextContent,
  Tool,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import * as Result from "effect/Result";
import { expect, test } from "vitest";
import { transcriptToRouteRequest } from "../../../src/facet/generation-1/route-request.js";
import { ROUTE_MODEL } from "../../../src/facet/generation-1/route-provider.js";
import { parseRequest } from "../../../src/model-route-wire/request.js";
import { decodeWire } from "../../model-route-wire/draws.js";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

const text = gs.text({ maxSize: 10 });

const identifier = gs.text({ alphabet: "abc_0", minSize: 1, maxSize: 6 });

const block = gs.oneOf<TextContent | ImageContent>(
  text.map((body): TextContent => ({ type: "text", text: body })),
  gs
    .sampledFrom(["image/png", "image/webp"])
    .map((mimeType): ImageContent => ({ type: "image", data: "AAA", mimeType })),
);

function drawArguments(tc: hegel.TestCase): JsonObject {
  const entries = tc.draw(
    gs.arrays(gs.tuples(identifier, gs.oneOf<string | number>(text, gs.integers())), {
      maxSize: 3,
    }),
  );

  return Object.fromEntries(entries);
}

function drawTools(tc: hegel.TestCase): Tool[] {
  const count = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));

  return Array.from({ length: count }, (_, index) => ({
    name: `tool_${index}`,
    description: tc.draw(text),
    parameters: obj(
      Object.fromEntries(tc.draw(gs.arrays(identifier, { maxSize: 2 })).map((key) => [key, str()])),
    ),
  }));
}

function drawAssistant(tc: hegel.TestCase): AssistantMessage {
  const content = tc.draw(
    gs.arrays(
      gs.oneOf<AssistantMessage["content"][number]>(
        text.map((body): TextContent => ({ type: "text", text: body })),
        text.map((thinking) => ({ type: "thinking" as const, thinking })),
        gs.tuples(identifier, identifier).map(([id, name]) => ({
          type: "toolCall" as const,
          id,
          name,
          arguments: {},
        })),
      ),
      { maxSize: 4 },
    ),
  );

  return {
    role: "assistant",
    content: content.map((part) =>
      part.type === "toolCall" ? { ...part, arguments: drawArguments(tc) } : part,
    ),
    api: ROUTE_MODEL.api,
    provider: ROUTE_MODEL.provider,
    model: ROUTE_MODEL.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: ZERO_COST },
    stopReason: "stop",
    timestamp: 0,
  };
}

function drawMessage(tc: hegel.TestCase): Message {
  const role = tc.draw(gs.sampledFrom(["user", "assistant", "toolResult"] as const));

  if (role === "assistant") return drawAssistant(tc);

  if (role === "user") {
    const content: UserMessage["content"] = tc.draw(
      gs.oneOf<UserMessage["content"]>(text, gs.arrays(block, { maxSize: 3 })),
    );

    return { role, content, timestamp: 0 };
  }

  const result: ToolResultMessage = {
    role,
    toolCallId: tc.draw(identifier),
    toolName: tc.draw(identifier),
    content: tc.draw(gs.arrays(block, { maxSize: 3 })),
    isError: false,
    timestamp: 0,
  };

  return result;
}

function drawContext(tc: hegel.TestCase): Context {
  const count = tc.draw(gs.integers({ minValue: 1, maxValue: 8 }));

  return {
    systemPrompt: tc.draw(text),
    tools: drawTools(tc),
    messages: Array.from({ length: count }, () => drawMessage(tc)),
  };
}

test("the request built from a transcript is one the model route accepts, unchanged", () => {
  hegel.test((tc) => {
    const context = drawContext(tc);
    const request = transcriptToRouteRequest(normalizeContext(context));
    const prompted = context.systemPrompt === "" ? 0 : 1;

    expect(parseRequest(request)).toStrictEqual(Result.succeed(request));
    expect(request.messages).toHaveLength(context.messages.length + prompted);
    expect(request.tools?.length ?? 0).toBe(context.tools?.length ?? 0);

    const sent = request.messages.flatMap((message) =>
      message.role === "assistant" ? message.tool_calls.map((call) => call.function.arguments) : [],
    );

    const written = context.messages.flatMap((message) =>
      message.role === "assistant"
        ? message.content.flatMap((part) => (part.type === "toolCall" ? [part.arguments] : []))
        : [],
    );

    expect(sent.map((json) => decodeWire(json))).toEqual(written);
  });
});
