import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { expect, test } from "vitest";
import { parseRequest, type RouteMessage, type ToolCall } from "../src/model-route-request.js";

const word = gs.text({ alphabet: "abc", minSize: 1, maxSize: 4 });

const text = gs.text({ maxSize: 8 });

const nonEmptyText = gs.text({ minSize: 1, maxSize: 8 });

type Drawn<Canonical> = Readonly<{ canonical: Canonical; wire: Schema.Json }>;

function withExtras(tc: hegel.TestCase, fields: Record<string, Schema.Json>): Schema.Json {
  const extras = tc.draw(gs.arrays(gs.tuples(word, text), { maxSize: 2 }));

  return { ...Object.fromEntries(extras.map(([key, value]) => [`x_${key}`, value])), ...fields };
}

function drawMany<T>(
  tc: hegel.TestCase,
  size: Readonly<{ minValue: number; maxValue: number }>,
  draw: (tc: hegel.TestCase) => T,
): T[] {
  return Array.from({ length: tc.draw(gs.integers(size)) }, () => draw(tc));
}

function drawToolCall(tc: hegel.TestCase): Drawn<ToolCall> {
  const id = tc.draw(nonEmptyText);
  const name = tc.draw(nonEmptyText);
  const args = tc.draw(text);

  return {
    canonical: { id, function: { name, arguments: args } },
    wire: withExtras(tc, { id, function: withExtras(tc, { name, arguments: args }) }),
  };
}

function drawAssistant(tc: hegel.TestCase): Drawn<RouteMessage> {
  const content = tc.draw(gs.oneOf(gs.just(null), text));
  const calls = drawMany(tc, { minValue: 0, maxValue: 2 }, drawToolCall);
  const omitsToolCalls = calls.length === 0 && tc.draw(gs.booleans());

  const base = { role: "assistant", content } as const;

  const wire = omitsToolCalls
    ? withExtras(tc, base)
    : withExtras(tc, { ...base, tool_calls: calls.map((call) => call.wire) });

  return {
    canonical: { role: "assistant", content, tool_calls: calls.map((call) => call.canonical) },
    wire,
  };
}

function drawMessage(tc: hegel.TestCase): Drawn<RouteMessage> {
  const role = tc.draw(gs.sampledFrom(["system", "user", "assistant", "tool"] as const));

  if (role === "assistant") return drawAssistant(tc);

  if (role === "tool") {
    const toolCallId = tc.draw(nonEmptyText);
    const content = tc.draw(text);

    return {
      canonical: { role, tool_call_id: toolCallId, content },
      wire: withExtras(tc, { role, tool_call_id: toolCallId, content }),
    };
  }

  const content = tc.draw(text);

  return { canonical: { role, content }, wire: withExtras(tc, { role, content }) };
}

test("a request is read as its canonical messages whatever extra keys it carries, and reading it again changes nothing", () => {
  hegel.test(
    (tc) => {
      const messages = drawMany(tc, { minValue: 1, maxValue: 4 }, drawMessage);

      const wire = withExtras(tc, { messages: messages.map((message) => message.wire) });

      const parsed = parseRequest(wire);

      expect(Result.getOrThrow(parsed)).toEqual({
        messages: messages.map((message) => message.canonical),
      });
      expect(parseRequest(Result.getOrThrow(parsed))).toEqual(parsed);
    },
    { testCases: 200 },
  );
});
