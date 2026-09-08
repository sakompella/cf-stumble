import { expect, test } from "vitest";
import { parseProviderChunk } from "../src/model-route-stream-parse.js";

test("a chat-completion chunk's text and tool call reach the route", () => {
  expect(
    parseProviderChunk({
      choices: [{ delta: { content: "ready", reasoning_content: null }, index: 0 }],
      usage: { prompt_tokens: 19, completion_tokens: 3 },
    }),
    "the deployed model streams its answer here, and the route reported the tokens without the text",
  ).toEqual({ textDelta: "ready", usage: { inputTokens: 19, outputTokens: 3 } });

  expect(
    parseProviderChunk({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", function: { name: "read", arguments: '{"path":' } },
            ],
          },
        },
      ],
    }),
  ).toEqual({
    toolCallDeltas: [{ index: 0, id: "call_1", name: "read", argumentsDelta: '{"path":' }],
  });
});

test("a reasoning-only chunk contributes no text", () => {
  expect(parseProviderChunk({ choices: [{ delta: { reasoning_content: "thinking" } }] })).toEqual(
    {},
  );
});
