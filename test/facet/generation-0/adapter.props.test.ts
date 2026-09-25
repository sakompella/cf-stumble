import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import {
  isResponseError,
  piContextToRouteRequest,
  routeResponseToPiAssistant,
  type PiAssistantMessage,
  type PiContentBlock,
  type PiMessage,
  type PiTextContent,
} from "../../../src/facet/generation-0/workers-ai-adapter.js";

const text = gs.text({ alphabet: "ab XYZ012-é日🙂\n", maxSize: 24 });

const identifier = gs.text({ alphabet: "abcXYZ012", minSize: 1, maxSize: 6 });

const argumentKey = gs.text({ alphabet: "kv", maxSize: 3 });

function assistant(content: ReadonlyArray<PiContentBlock>): PiAssistantMessage {
  return {
    role: "assistant",
    content,
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

test("every tool-argument string becomes a plain non-array object", () => {
  hegel.test((tc) => {
    const argumentsText = tc.draw(
      gs.oneOf(
        gs.text({ maxSize: 20 }),
        gs.sampledFrom(["[]", "[1]", "null", "3", '"text"', "{}", '{"items":[1]}']),
      ),
    );

    const result = routeResponseToPiAssistant({
      ok: true,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call", function: { name: "run", arguments: argumentsText } }],
      },
    });

    expect(isResponseError(result)).toBe(false);

    if (isResponseError(result)) throw new Error("expected a successful assistant response");

    const call = result.content[0];

    if (call?.type !== "toolCall") throw new Error("expected one tool call");

    expect(call.arguments).not.toBeNull();
    expect(Array.isArray(call.arguments)).toBe(false);
    expect(Object.getPrototypeOf(call.arguments)).toBe(Object.prototype);
  });
});

function assertRouteAssistantRoundTrip(tc: hegel.TestCase): void {
  const content = tc.draw(gs.optional(text));

  const calls = tc.draw(
    gs.arrays(
      gs.record({
        id: identifier,
        name: identifier,
        arguments: gs.maps(argumentKey, text, { maxSize: 3 }),
      }),
      { maxSize: 3 },
    ),
  );

  const expectedArguments = calls.map((call) => Object.fromEntries(call.arguments));

  const routeMessage = {
    role: "assistant" as const,
    content: content ?? null,
    tool_calls: calls.map((call, index) => ({
      id: call.id,
      function: { name: call.name, arguments: JSON.stringify(expectedArguments[index]) },
    })),
  };

  const pi = routeResponseToPiAssistant({ ok: true, message: routeMessage });

  expect(isResponseError(pi)).toBe(false);

  if (isResponseError(pi)) throw new Error("expected a successful assistant response");

  const mapped = piContextToRouteRequest({ messages: [pi] }).messages[0];

  if (mapped?.role !== "assistant") throw new Error("expected an assistant route message");

  expect(mapped.content).toBe(routeMessage.content);
  expect(mapped.tool_calls).toHaveLength(routeMessage.tool_calls.length);

  for (const [index, expected] of routeMessage.tool_calls.entries()) {
    const actual = mapped.tool_calls[index];

    expect(actual?.id).toBe(expected.id);
    expect(actual?.function.name).toBe(expected.function.name);
    expect(JSON.parse(actual?.function.arguments ?? "null")).toEqual(expectedArguments[index]);
  }
}

function assertMixedContextPreservesOrder(tc: hegel.TestCase): void {
  const roles = tc.draw(
    gs.arrays(gs.sampledFrom(["user", "assistant", "tool"] as const), {
      minSize: 1,
      maxSize: 6,
    }),
  );

  const systemPrompt = tc.draw(gs.optional(text));
  const messages: PiMessage[] = [];
  const toolIds: string[] = [];

  for (const role of roles) {
    if (role === "user") {
      const value = tc.draw(text);

      const contentValue: string | ReadonlyArray<PiTextContent> = tc.draw(gs.booleans())
        ? [{ type: "text", text: value }]
        : value;

      messages.push({ role, content: contentValue, timestamp: 0 });
    } else if (role === "assistant") {
      messages.push(assistant([{ type: "text", text: tc.draw(text) }]));
    } else {
      const id = tc.draw(identifier);

      toolIds.push(id);
      messages.push({
        role: "toolResult",
        toolCallId: id,
        toolName: "tool",
        content: [{ type: "text", text: tc.draw(text) }],
        isError: false,
        timestamp: 0,
      });
    }
  }

  const context = systemPrompt === null ? { messages } : { systemPrompt, messages };
  const mappedContext = piContextToRouteRequest(context).messages;
  const expectedRoles = systemPrompt !== null && systemPrompt !== "" ? ["system", ...roles] : roles;

  expect(mappedContext.map((message) => message.role)).toEqual(expectedRoles);
  expect(
    mappedContext.flatMap((message) => (message.role === "tool" ? [message.tool_call_id] : [])),
  ).toEqual(toolIds);
}

test("route assistant messages and mixed Pi contexts preserve their documented fields", () => {
  hegel.test((tc) => {
    assertRouteAssistantRoundTrip(tc);
    assertMixedContextPreservesOrder(tc);
  });
});
