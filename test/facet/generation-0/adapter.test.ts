import { expect, test } from "vitest";
import {
  piContextToRouteRequest,
  routeResponseToPiAssistant,
  isResponseError,
  type PiAssistantMessage,
  type PiContext,
  type PiToolResultMessage,
  type PiUsage,
  type AdapterError,
} from "../../../src/facet/generation-0/workers-ai-adapter.js";
import type { ModelRouteRequest, ModelRouteResponse } from "../../../src/model-route.js";

const ZERO: PiUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function piAssistant(
  content: PiAssistantMessage["content"],
  stopReason = "stop",
): PiAssistantMessage {
  return {
    role: "assistant",
    content,
    api: "test",
    provider: "test",
    model: "m",
    usage: ZERO,
    stopReason,
    timestamp: 1000,
  };
}

function fakeRoute(responses: ReadonlyArray<ModelRouteResponse>) {
  const calls: ModelRouteRequest[] = [];
  let i = 0;
  return {
    calls,
    run(req: ModelRouteRequest) {
      calls.push(req);
      const r = responses[i];
      if (r === undefined) throw new Error("exhausted");
      i += 1;
      return r;
    },
  };
}

function expectPi(v: PiAssistantMessage | AdapterError): PiAssistantMessage {
  expect(isResponseError(v)).toBe(false);
  if (isResponseError(v)) throw new Error("error");
  return v;
}

function tcRes(id: string, name: string, args: string): ModelRouteResponse {
  return {
    ok: true,
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{ id, function: { name, arguments: args } }],
    },
  };
}

function txtRes(t: string): ModelRouteResponse {
  return { ok: true, message: { role: "assistant", content: t, tool_calls: [] } };
}

function piTr(id: string, name: string, text: string): PiToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 200,
  };
}

const TOOL: PiContext["tools"] = [
  {
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
];

// -- Two-call tool cycle ----------------------------------------------------

test("cycle step 1: model returns a tool call from the initial request", () => {
  const route = fakeRoute([tcRes("call_42", "read_file", '{"path":"a.txt"}')]);
  const ctx: PiContext = {
    systemPrompt: "Help.",
    messages: [{ role: "user", content: "Read a.txt", timestamp: 100 }],
    tools: TOOL,
  };
  const a = expectPi(routeResponseToPiAssistant(route.run(piContextToRouteRequest(ctx))));
  expect(a.stopReason).toBe("toolUse");
  const tc = a.content[0];
  if (tc?.type === "toolCall") {
    expect(tc.id).toBe("call_42");
    expect(tc.arguments).toEqual({ path: "a.txt" });
  } else {
    expect.unreachable("expected toolCall");
  }
});

test("cycle step 2: tool result fed back produces final text", () => {
  const a1 = expectPi(
    routeResponseToPiAssistant(tcRes("call_42", "read_file", '{"path":"a.txt"}')),
  );
  const route = fakeRoute([txtRes("File contents: hello")]);
  const ctx: PiContext = {
    systemPrompt: "Help.",
    messages: [
      { role: "user", content: "Read a.txt", timestamp: 100 },
      a1,
      piTr("call_42", "read_file", "hello"),
    ],
    tools: TOOL,
  };
  const req = piContextToRouteRequest(ctx);
  expect(req.messages).toHaveLength(4);
  expect(req.messages[3]?.role).toBe("tool");
  const a2 = expectPi(routeResponseToPiAssistant(route.run(req)));
  expect(a2.stopReason).toBe("stop");
  expect(a2.content).toEqual([{ type: "text", text: "File contents: hello" }]);
});

// -- Round-trip stability per role ------------------------------------------

test("user message preserves content including TextContent array", () => {
  expect(
    piContextToRouteRequest({ messages: [{ role: "user", content: "hi", timestamp: 1 }] }).messages,
  ).toEqual([{ role: "user", content: "hi" }]);
  const arr = piContextToRouteRequest({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "a " },
          { type: "text", text: "b" },
        ],
        timestamp: 1,
      },
    ],
  });
  expect(arr.messages[0]).toEqual({ role: "user", content: "a b" });
});

test("system prompt becomes a system message; empty prompt omitted", () => {
  const req = piContextToRouteRequest({
    systemPrompt: "Be concise.",
    messages: [{ role: "user", content: "hi", timestamp: 1 }],
  });
  expect(req.messages[0]).toEqual({ role: "system", content: "Be concise." });
  expect(
    piContextToRouteRequest({
      systemPrompt: "",
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    }).messages,
  ).toHaveLength(1);
});

test("assistant text survives conversion", () => {
  const m = piContextToRouteRequest({ messages: [piAssistant([{ type: "text", text: "ok" }])] })
    .messages[0];
  if (m?.role === "assistant") expect(m.content).toBe("ok");
  else expect.unreachable("expected assistant");
});

test("assistant tool call arguments serialised to JSON", () => {
  const m = piContextToRouteRequest({
    messages: [
      piAssistant([{ type: "toolCall", id: "c1", name: "w", arguments: { p: 1 } }], "toolUse"),
    ],
  }).messages[0];
  if (m?.role === "assistant") expect(m.tool_calls[0]?.function.arguments).toBe('{"p":1}');
  else expect.unreachable("expected assistant");
});

test("tool result maps role and id", () => {
  expect(piContextToRouteRequest({ messages: [piTr("c99", "bash", "ok")] }).messages[0]).toEqual({
    role: "tool",
    tool_call_id: "c99",
    content: "ok",
  });
});

test("thinking blocks dropped from assistant messages", () => {
  const m = piContextToRouteRequest({
    messages: [
      piAssistant([
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "a" },
      ]),
    ],
  }).messages[0];
  if (m?.role === "assistant") {
    expect(m.content).toBe("a");
    expect(m.tool_calls).toEqual([]);
  } else expect.unreachable("expected assistant");
});

test("Pi tools mapped to route tool definitions", () => {
  const req = piContextToRouteRequest({
    messages: [{ role: "user", content: "go", timestamp: 1 }],
    tools: TOOL,
  });
  expect(req.tools?.[0]).toEqual({
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    },
  });
});

test("route text response becomes Pi text content with stop", () => {
  const pi = expectPi(routeResponseToPiAssistant(txtRes("done")));
  expect(pi.content).toEqual([{ type: "text", text: "done" }]);
  expect(pi.stopReason).toBe("stop");
});

test("route tool call response becomes Pi toolCall content with toolUse", () => {
  const pi = expectPi(routeResponseToPiAssistant(tcRes("c7", "bash", '{"cmd":"ls"}')));
  expect(pi.stopReason).toBe("toolUse");
  expect(pi.content).toEqual([
    { type: "toolCall", id: "c7", name: "bash", arguments: { cmd: "ls" } },
  ]);
});

test("route error returns AdapterError", () => {
  expect(routeResponseToPiAssistant({ ok: false, error: { code: "model-unavailable" } })).toEqual({
    code: "model-unavailable",
    detail: "model-unavailable",
  } satisfies AdapterError);
});

test.each([["not-json{"], ['"just a string"']])(
  "invalid tool args %s recovered as empty object",
  (args) => {
    const pi = expectPi(
      routeResponseToPiAssistant({
        ok: true,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", function: { name: "r", arguments: args } }],
        },
      }),
    );
    if (pi.content[0]?.type === "toolCall") expect(pi.content[0].arguments).toEqual({});
    else expect.unreachable("expected toolCall");
  },
);

// -- No provider configuration reachable ------------------------------------

test("route request carries no provider override fields", () => {
  const req = piContextToRouteRequest({
    systemPrompt: "S",
    messages: [
      { role: "user", content: "go", timestamp: 1 },
      piAssistant([{ type: "toolCall", id: "c1", name: "r", arguments: { x: 1 } }], "toolUse"),
      piTr("c1", "r", "ok"),
    ],
    tools: [{ name: "r", description: "R", parameters: {} }],
  });
  for (const k of ["model", "reasoning_effort", "credentials", "endpoint", "provider"]) {
    expect(Object.keys(req)).not.toContain(k);
  }
});

test("Pi output carries zero usage and synthetic provider tag", () => {
  const pi = expectPi(routeResponseToPiAssistant(txtRes("hi")));
  expect(pi.api).toBe("workers-ai");
  expect(pi.provider).toBe("cloudflare-workers-ai");
  expect(pi.model).toBe("adapter-passthrough");
  expect(pi.usage.totalTokens).toBe(0);
});

test("absent or empty tools omits the tools field", () => {
  expect(
    piContextToRouteRequest({ messages: [{ role: "user", content: "hi", timestamp: 1 }] }).tools,
  ).toBeUndefined();
  expect(
    piContextToRouteRequest({
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
      tools: [],
    }).tools,
  ).toBeUndefined();
});
