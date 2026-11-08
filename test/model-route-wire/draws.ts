import type * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Schema from "effect/Schema";

import type {
  AssistantMessage,
  ModelRouteRequest,
  RouteMessage,
  ToolDefinition,
} from "../../src/model-route-wire/request.js";

export const decodeWire = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

export function drawTool(tc: hegel.TestCase): ToolDefinition {
  const property = tc.draw(gs.text({ alphabet: "abc_", minSize: 1, maxSize: 6 }));

  return {
    type: "function",
    function: {
      name: tc.draw(gs.text({ alphabet: "abcXYZ_-", minSize: 1, maxSize: 12 })),
      description: tc.draw(gs.text({ maxSize: 20 })),
      parameters: { type: "object", properties: { [property]: { type: "string" } } },
    },
  };
}

export function drawTools(tc: hegel.TestCase): ToolDefinition[] {
  const count = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));

  return Array.from({ length: count }, () => drawTool(tc));
}

export const text = gs.text({ maxSize: 12 });

const identifier = gs.text({ alphabet: "abc_-0", minSize: 1, maxSize: 8 });

const ROLES = ["system", "user", "assistant", "tool"] as const;

function drawToolCall(tc: hegel.TestCase): AssistantMessage["tool_calls"][number] {
  return {
    id: tc.draw(identifier),
    function: { name: tc.draw(identifier), arguments: tc.draw(text) },
  };
}

function drawMessage(tc: hegel.TestCase): RouteMessage {
  const role = tc.draw(gs.sampledFrom(ROLES));

  if (role === "system" || role === "user") return { role, content: tc.draw(text) };

  if (role === "tool") {
    return { role, tool_call_id: tc.draw(identifier), content: tc.draw(text) };
  }

  const calls = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));

  return {
    role,
    content: tc.draw(gs.oneOf(text, gs.just(null))),
    tool_calls: Array.from({ length: calls }, () => drawToolCall(tc)),
  };
}

export function drawRequest(tc: hegel.TestCase): ModelRouteRequest {
  const count = tc.draw(gs.integers({ minValue: 1, maxValue: 6 }));
  const messages = Array.from({ length: count }, () => drawMessage(tc));

  return tc.draw(gs.booleans()) ? { messages } : { messages, tools: drawTools(tc) };
}
