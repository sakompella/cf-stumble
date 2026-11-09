import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Result from "effect/Result";
import { expect, test } from "vitest";

import { parseRequest, type ToolDefinition } from "../../src/model-route-wire/request.js";
import { decodeWire, drawTools, drawTool } from "./draws.js";

const USER = { role: "user", content: "Hi" } as const;

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
    const tools: Array<ToolDefinition | ReturnType<typeof corrupted>> = drawTools(tc);
    const index = tc.draw(gs.integers({ minValue: 0, maxValue: tools.length }));
    const fieldName = tc.draw(gs.sampledFrom(TOOL_FIELDS));

    const value = tc.draw(
      gs.sampledFrom<(typeof WRONG_VALUES)[ToolField][number]>(WRONG_VALUES[fieldName]),
    );

    tools.splice(index, 0, corrupted(drawTool(tc), fieldName, value));

    const parsed = parseRequest(decodeWire(JSON.stringify({ messages: [USER], tools })));
    const failure = Result.isFailure(parsed) ? parsed.failure : undefined;

    expect(failure?.error, `tools[${index}]`).toMatchObject({ code: "invalid-request" });
    expect(failure?.error.reason, `tools[${index}]`).toContain(`tools[${index}]`);
  });
});
