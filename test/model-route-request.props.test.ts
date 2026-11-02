import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Result from "effect/Result";
import { expect, test } from "vitest";

import {
  parseRequest,
  type ModelRouteRequest,
  type RouteMessage,
  type ToolCall,
} from "../src/model-route-request.js";
import { decodeWire, drawRequest, text } from "./model-route-draws.js";

const MAX_REQUEST_BYTES = 1_048_576;

type Broken =
  | readonly Broken[]
  | { readonly [key: string]: Broken }
  | string
  | number
  | boolean
  | null
  | undefined;

type Mutant = Readonly<{
  where: string;
  values: readonly Broken[];
  build: (value: Broken) => string;
}>;

type Splice = (changed: Broken) => string;

function replaceAt<Item, Changed>(
  items: readonly Item[],
  index: number,
  changed: Changed,
): (Item | Changed)[] {
  return items.map((item, position) => (position === index ? changed : item));
}

const ENTRY_VALUES: readonly Broken[] = [42, "s", null, [], true];

const CONTENT_VALUES: readonly Broken[] = [undefined, 1, null, {}, []];

const IDENTIFIER_VALUES: readonly Broken[] = [undefined, "", 1, null];

function callMutants(call: ToolCall, where: string, withCall: Splice): Mutant[] {
  return [
    { where, values: ENTRY_VALUES, build: (value) => withCall(value) },
    { where, values: IDENTIFIER_VALUES, build: (value) => withCall({ ...call, id: value }) },
    {
      where,
      values: [undefined, "x", null, []],
      build: (value) => withCall({ ...call, function: value }),
    },
    {
      where,
      values: [undefined, "", 1],
      build: (value) => withCall({ ...call, function: { ...call.function, name: value } }),
    },
    {
      where,
      values: [undefined, 1, null, {}],
      build: (value) => withCall({ ...call, function: { ...call.function, arguments: value } }),
    },
  ];
}

function messageMutants(
  request: ModelRouteRequest,
  message: RouteMessage,
  index: number,
): Mutant[] {
  const where = `messages[${index}]`;

  const withMessage: Splice = (changed) =>
    JSON.stringify({ ...request, messages: replaceAt(request.messages, index, changed) });

  const field = (name: string, values: readonly Broken[]): Mutant => ({
    where,
    values,
    build: (value) => withMessage({ ...message, [name]: value }),
  });

  const common: Mutant[] = [
    { where, values: ENTRY_VALUES, build: (value) => withMessage(value) },
    field("role", [undefined, "", "function", "System", 1, null]),
  ];

  if (message.role === "assistant") {
    const calls = message.tool_calls;

    return [
      ...common,
      field("content", [undefined, 1, {}, []]),
      field("tool_calls", [1, "x", null, {}]),
      ...calls.flatMap((call, position) =>
        callMutants(call, where, (changed) =>
          withMessage({ ...message, tool_calls: replaceAt(calls, position, changed) }),
        ),
      ),
    ];
  }

  if (message.role === "tool") {
    return [...common, field("content", CONTENT_VALUES), field("tool_call_id", IDENTIFIER_VALUES)];
  }

  return [...common, field("content", CONTENT_VALUES)];
}

function mutantsOf(request: ModelRouteRequest): Mutant[] {
  const tools = request.tools ?? [];

  return [
    ...request.messages.flatMap((message, index) => messageMutants(request, message, index)),
    ...tools.map((_tool, index) => ({
      where: `tools[${index}]`,
      values: ENTRY_VALUES,
      build: (value: Broken) =>
        JSON.stringify({ ...request, tools: replaceAt(tools, index, value) }),
    })),
    {
      where: "",
      values: [undefined, [], null, 1, "x", {}],
      build: (value) => JSON.stringify({ ...request, messages: value }),
    },
    {
      where: "",
      values: [42, "read", null, {}],
      build: (value) => JSON.stringify({ ...request, tools: value }),
    },
    { where: "", values: [42, null, "x", []], build: (value) => JSON.stringify(value) },
  ];
}

test("a valid request with one message, call or container broken is refused, naming the message", () => {
  hegel.test((tc) => {
    const broken = mutantsOf(drawRequest(tc)).flatMap((mutant) =>
      mutant.values.map((value) => ({ where: mutant.where, json: mutant.build(value) })),
    );

    for (const { where, json } of broken) {
      const parsed = parseRequest(decodeWire(json));

      expect(Result.isFailure(parsed) ? parsed.failure : "parsed", json).toMatchObject({
        ok: false,
        error: { code: "invalid-request" },
      });

      expect(Result.isFailure(parsed) ? parsed.failure.error.reason : "parsed", json).toContain(
        where,
      );
    }
  });
});

function withJunk<Fields extends object>(tc: hegel.TestCase, fields: Fields) {
  return { ...fields, [tc.draw(gs.fromRegex("x_[a-z]{1,5}"))]: tc.draw(text) };
}

function withJunkMessage(tc: hegel.TestCase, message: RouteMessage) {
  if (message.role !== "assistant") return withJunk(tc, message);

  if (message.tool_calls.length === 0 && tc.draw(gs.booleans())) {
    return withJunk(tc, { role: message.role, content: message.content });
  }

  const calls = message.tool_calls.map((call) =>
    withJunk(tc, { ...call, function: withJunk(tc, call.function) }),
  );

  return withJunk(tc, { ...message, tool_calls: calls });
}

test("a request carrying fields the route does not know parses to its normalized form", () => {
  hegel.test((tc) => {
    const request = drawRequest(tc);
    const messages = request.messages.map((message) => withJunkMessage(tc, message));

    const tools = request.tools?.map((tool) =>
      withJunk(tc, { ...tool, function: withJunk(tc, tool.function) }),
    );

    const noisy = withJunk(tc, { messages, tools });
    const normalized = Result.succeed(request);

    expect(parseRequest(decodeWire(JSON.stringify(noisy)))).toStrictEqual(normalized);
    expect(parseRequest(request)).toStrictEqual(normalized);
  });
});

test("the size limit counts the UTF-8 bytes of the request, whatever the characters", () => {
  const empty = JSON.stringify({ messages: [{ role: "user", content: "" }] });
  const envelope = new TextEncoder().encode(empty).length;

  hegel.test(
    (tc) => {
      const delta = tc.draw(
        gs.oneOf(
          gs.integers({ minValue: -4, maxValue: 4 }),
          gs.integers({ minValue: -100_000, maxValue: 100_000 }),
        ),
      );

      const budget = MAX_REQUEST_BYTES - envelope + delta;
      const fourByte = tc.draw(gs.integers({ minValue: 0, maxValue: Math.floor(budget / 4) }));
      const afterFour = budget - 4 * fourByte;
      const threeByte = tc.draw(gs.integers({ minValue: 0, maxValue: Math.floor(afterFour / 3) }));
      const afterThree = afterFour - 3 * threeByte;
      const twoByte = tc.draw(gs.integers({ minValue: 0, maxValue: Math.floor(afterThree / 2) }));

      const content = [
        "\u{1F600}".repeat(fourByte),
        "\u20AC".repeat(threeByte),
        "\u00E9".repeat(twoByte),
        "a".repeat(afterThree - 2 * twoByte),
      ].join("");

      expect(Result.isSuccess(parseRequest({ messages: [{ role: "user", content }] }))).toBe(
        delta <= 0,
      );
    },
    { testCases: 50 },
  );
});
