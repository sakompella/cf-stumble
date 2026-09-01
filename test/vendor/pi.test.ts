import { Agent } from "@cf-stumble/pi";
import type { Api, Model, StreamFn } from "@cf-stumble/pi";
import { expect, test } from "vitest";

declare global {
  interface ImportMeta {
    glob: (
      pattern: string,
      options: { readonly eager: true; readonly query: "?raw"; readonly import: "default" },
    ) => Record<string, string>;
  }
}

const builtPi = Object.values(
  import.meta.glob("../../vendor/pi-v0.84.4/dist/index.js", {
    eager: true,
    query: "?raw",
    import: "default",
  }),
).at(0) ?? "";

const model = {
  id: "test-model",
  name: "Test model",
  api: "openai-completions",
  provider: "test-provider",
  baseUrl: "https://example.test/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 1_024,
} satisfies Model<Api>;

const streamFn: StreamFn = () => Promise.reject(new Error("The constructor must not call the stream function"));

test("constructs an Agent from the built vendored package", () => {
  const agent = new Agent({ streamFn, initialState: { model } });

  expect(agent.state.model).toEqual(model);
  expect(agent.state.messages).toEqual([]);
});

test("builds Pi without a node:os reference", () => {
  expect(builtPi).not.toContain("node:os");
});
