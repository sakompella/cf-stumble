import { expect, test } from "vitest";
import {
  fixedModelInput,
  MODEL,
  invokeFixedModel,
  type FixedModelInput,
  type ModelInference,
} from "../src/model-route.js";

test("invokes the fixed GLM route with the exact low-effort payload", async () => {
  const calls: Array<{ model: string; input: FixedModelInput }> = [];
  const ai: ModelInference = {
    run(model, input) {
      calls.push({ model, input });
      return Promise.resolve({ answer: "ok" });
    },
  };

  const result = await invokeFixedModel(ai, "Explain this change.");

  expect(calls).toEqual([
    {
      model: MODEL,
      input: {
        messages: [
          { role: "system", content: "You are a coding assistant." },
          { role: "user", content: "Explain this change." },
        ],
        reasoning_effort: "low",
      },
    },
  ]);
  expect(result).toEqual({ ok: true, result: { answer: "ok" } });
});

test("exposes no arbitrary provider configuration", async () => {
  const calls: Array<{ model: string; input: FixedModelInput }> = [];
  const ai: ModelInference = {
    run(model, input) {
      calls.push({ model, input });
      return Promise.resolve({});
    },
  };

  await invokeFixedModel(ai, "prompt");

  expect(Object.keys(fixedModelInput("prompt"))).toEqual(["messages", "reasoning_effort"]);
  expect(calls[0]).toEqual({
    model: MODEL,
    input: {
      messages: [
        { role: "system", content: "You are a coding assistant." },
        { role: "user", content: "prompt" },
      ],
      reasoning_effort: "low",
    },
  });
});

test("redacts inference failures to a stable safe error", async () => {
  const ai: ModelInference = {
    run() {
      return Promise.reject(new Error("provider secret and request token"));
    },
  };

  await expect(invokeFixedModel(ai, "prompt")).resolves.toEqual({
    ok: false,
    error: { code: "model-unavailable" },
  });
});
