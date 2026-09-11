import {
  Agent,
  AssistantMessageEventStream,
  ExecutionError,
  FileError,
  createAssistantMessageEventStream,
} from "@cf-stumble/pi";
import * as Pi from "@cf-stumble/pi";
import type { AssistantMessage, AssistantMessageEvent, Api, Model, StreamFn } from "@cf-stumble/pi";
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

test("the built package's runtime namespace has exactly the expected keys", () => {
  // `import * as Pi` resolves through the package's `exports` field to the built
  // `dist/index.js` bundle, so this reads the actual runtime surface rather than the
  // TypeScript-only declaration surface. A `export type { FileError }` typo, or a bundler
  // dropping a value export, would either omit the key here or leave it `undefined`.
  expect(Object.keys(Pi).toSorted()).toEqual(
    [
      "Agent",
      "AssistantMessageEventStream",
      "DEFAULT_COMPACTION_SETTINGS",
      "ExecutionError",
      "FileError",
      "compact",
      "convertToLlm",
      "createAssistantMessageEventStream",
      "createBashTool",
      "createCompactionSummaryMessage",
      "createEditTool",
      "createGatewayBindingFetch",
      "createReadTool",
      "createWriteTool",
      "estimateContextTokens",
      "prepareCompaction",
      "shouldCompact",
      "streamSimple",
      "truncateTail",
    ].toSorted(),
  );
  expect(Pi.FileError).toBeTypeOf("function");
  expect(Pi.ExecutionError).toBeTypeOf("function");
  expect(Pi.AssistantMessageEventStream).toBeTypeOf("function");
  expect(Pi.createAssistantMessageEventStream).toBeTypeOf("function");
});

/**
 * The compaction surface T7 added to the facade. It is a value export, not a declaration: the
 * facet has to be able to call these at runtime inside workerd, and `vendor/pi-v0.84.4/index.ts`
 * is generated, so a mistake in the generator's facade source would show up here as a missing
 * function rather than as a compile error.
 */
test("the vendored compaction surface is callable, and reads the model's context window", () => {
  expect(Pi.compact).toBeTypeOf("function");
  expect(Pi.prepareCompaction).toBeTypeOf("function");
  expect(Pi.convertToLlm).toBeTypeOf("function");
  expect(Pi.DEFAULT_COMPACTION_SETTINGS.enabled).toBe(true);

  const settings = Pi.DEFAULT_COMPACTION_SETTINGS;
  expect(Pi.estimateContextTokens([]).tokens).toBe(0);

  // The fact T7 had to settle before it could claim a forced-compaction test: `shouldCompact`
  // compares against `contextWindow - reserveTokens`, so the zero window `ROUTE_MODEL` declares
  // does not disable compaction. It makes an empty conversation exceed the threshold, which is why
  // this generation compacts against a budget it declares instead (`turn-policy.ts`).
  expect(Pi.shouldCompact(0, 0, settings)).toBe(true);
  expect(Pi.shouldCompact(0, 64_000, settings)).toBe(false);
  expect(Pi.shouldCompact(64_000 - settings.reserveTokens + 1, 64_000, settings)).toBe(true);
});

test("FileError carries its code, path, and cause", () => {
  const cause = new Error("disk unavailable");
  const error = new FileError("not_found", "missing file", "/tmp/missing.txt", cause);

  expect(error).toBeInstanceOf(Error);
  expect(error).toBeInstanceOf(FileError);
  expect(error.name).toBe("FileError");
  expect(error.code).toBe("not_found");
  expect(error.path).toBe("/tmp/missing.txt");
  expect(error.cause).toBe(cause);
});

test("ExecutionError carries its code and cause", () => {
  const cause = new Error("spawn failed");
  const error = new ExecutionError("spawn_error", "could not start the shell", cause);

  expect(error).toBeInstanceOf(Error);
  expect(error).toBeInstanceOf(ExecutionError);
  expect(error.name).toBe("ExecutionError");
  expect(error.code).toBe("spawn_error");
  expect(error.cause).toBe(cause);
});

test("createAssistantMessageEventStream resolves a terminal done event through iteration and result()", async () => {
  const finalMessage = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: "openai-completions",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  } satisfies AssistantMessage;

  const doneEvent = { type: "done", reason: "stop", message: finalMessage } satisfies AssistantMessageEvent;

  const stream = createAssistantMessageEventStream();
  expect(stream).toBeInstanceOf(AssistantMessageEventStream);

  stream.push(doneEvent);

  const seen: AssistantMessageEvent[] = [];

  for await (const event of stream) {
    seen.push(event);
  }

  expect(seen).toEqual([doneEvent]);

  await expect(stream.result()).resolves.toEqual(finalMessage);
});
