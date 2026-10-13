import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Result from "effect/Result";
import { expect, test } from "vitest";

import { parseRequest, type ToolDefinition } from "../src/model-route-request.js";

const USER = { role: "user", content: "Hi" } as const;

function drawTool(tc: hegel.TestCase): ToolDefinition {
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

function drawTools(tc: hegel.TestCase): ToolDefinition[] {
  const count = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));

  return Array.from({ length: count }, () => drawTool(tc));
}

/** A value of the wrong type for each field a tool definition must carry. */
const WRONG_VALUES = {
  type: [undefined, "", "Function", "web_search", 1, null, {}],
  function: [undefined, "read", 1, null, []],
  name: [undefined, "", 1, null, {}, []],
  description: [undefined, 1, null, {}, []],
  parameters: [undefined, null, [], "{}", 1, true],
} as const;

type ToolField = keyof typeof WRONG_VALUES;

const TOOL_FIELDS: readonly ToolField[] = ["type", "function", "name", "description", "parameters"];

function corrupted(
  tool: ToolDefinition,
  fieldName: ToolField,
  value: (typeof WRONG_VALUES)[ToolField][number],
) {
  if (fieldName === "type") return { ...tool, type: value };

  if (fieldName === "function") return { ...tool, function: value };

  return { ...tool, function: { ...tool.function, [fieldName]: value } };
}

test("generated tool definitions parse to themselves", () => {
  hegel.test((tc) => {
    const tools = drawTools(tc);

    expect(parseRequest({ messages: [USER], tools })).toEqual(
      Result.succeed({ messages: [USER], tools }),
    );
  });
});

test("a tool with one field of the wrong type or missing is rejected at its index", () => {
  hegel.test((tc) => {
    const tools: unknown[] = drawTools(tc);
    const index = tc.draw(gs.integers({ minValue: 0, maxValue: tools.length }));
    const fieldName = tc.draw(gs.sampledFrom(TOOL_FIELDS));

    const value = tc.draw(
      gs.sampledFrom<(typeof WRONG_VALUES)[ToolField][number]>(WRONG_VALUES[fieldName]),
    );

    tools.splice(index, 0, corrupted(drawTool(tc), fieldName, value));

    const reason = Result.match(parseRequest({ messages: [USER], tools }), {
      onSuccess: () => "parsed",
      onFailure: (failure) => failure.error.reason,
    });

    expect(reason).toMatch(new RegExp(`^tools\\[${index}\\] `, "u"));
  });
});
