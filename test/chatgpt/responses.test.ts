import { expect, test } from "vitest";
import { responsesRequest } from "../../src/chatgpt/responses.js";
import type { ModelRouteRequest } from "../../src/model-route-wire/request.js";

const MODEL = "gpt-test";

test("the leading system messages become the instructions and later ones stay in place", () => {
  const request: ModelRouteRequest = {
    messages: [
      { role: "system", content: "baseline" },
      { role: "system", content: "extra baseline" },
      { role: "user", content: "hello" },
      { role: "system", content: "patch" },
      { role: "system", content: "" },
      { role: "assistant", content: "hi", tool_calls: [] },
    ],
  };

  expect(responsesRequest(MODEL, request)).toEqual({
    model: MODEL,
    instructions: "baseline\n\nextra baseline",
    input: [
      { role: "user", content: "hello" },
      { role: "developer", content: "patch" },
      { role: "assistant", content: "hi" },
    ],
    reasoning: { effort: "medium" },
    store: false,
    stream: true,
  });
});

test("a conversation without system text has no instructions and no developer items", () => {
  const request: ModelRouteRequest = {
    messages: [
      { role: "system", content: "" },
      { role: "user", content: "hello" },
      { role: "system", content: "" },
    ],
  };

  expect(responsesRequest(MODEL, request)).toEqual({
    model: MODEL,
    input: [{ role: "user", content: "hello" }],
    reasoning: { effort: "medium" },
    store: false,
    stream: true,
  });
});

test("a system-only conversation carries its whole prompt as the instructions", () => {
  const request: ModelRouteRequest = {
    messages: [
      { role: "system", content: "one" },
      { role: "system", content: "two" },
    ],
  };

  expect(responsesRequest(MODEL, request)).toMatchObject({ instructions: "one\n\ntwo", input: [] });
});
