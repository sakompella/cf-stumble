import { expect, test } from "vitest";
import type { ValidationFailure } from "../../../src/model-route.js";
import {
  GO,
  NO_USAGE,
  pushableStream,
  replies,
  scriptedRoute,
  streamThroughProvider as stream,
} from "./scripted-route.js";

async function settle(events: AsyncIterable<{ type: string }>): Promise<string[]> {
  const types: string[] = [];

  for await (const event of events) types.push(event.type);

  return types;
}

test("text deltas stream into one text block, and done carries the route's usage", async () => {
  const { capability } = scriptedRoute(
    replies([
      { type: "text-delta", delta: "Hello " },
      { type: "text-delta", delta: "there" },
      {
        type: "done",
        message: { role: "assistant", content: "Hello there", tool_calls: [] },
        usage: { inputTokens: 12, outputTokens: 3, estimated: false },
      },
    ]),
  );

  const reply = stream(capability, GO);
  const types = await settle(reply);
  const message = await reply.result();

  expect(types).toEqual(["start", "text_start", "text_delta", "text_delta", "text_end", "done"]);
  expect(message).toMatchObject({
    stopReason: "stop",
    content: [{ type: "text", text: "Hello there" }],
    usage: { input: 12, output: 3, totalTokens: 15 },
  });
});

test("a tool call assembles from streamed argument deltas", async () => {
  const { capability } = scriptedRoute(
    replies([
      {
        type: "tool-call-delta",
        delta: { index: 0, id: "call_1", name: "bash", argumentsDelta: '{"cmd":' },
      },
      { type: "tool-call-delta", delta: { index: 0, argumentsDelta: '"ls"}' } },
      {
        type: "done",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", function: { name: "bash", arguments: '{"cmd":"ls"}' } }],
        },
        usage: NO_USAGE,
      },
    ]),
  );

  const reply = stream(capability, GO);
  const deltas: string[] = [];

  for await (const event of reply) {
    if (event.type === "toolcall_delta") deltas.push(event.delta);
  }

  expect(deltas).toEqual(['{"cmd":', '"ls"}']);
  expect(await reply.result()).toMatchObject({
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { cmd: "ls" } }],
  });
});

test("a provider fallback stays on the final message as a diagnostic", async () => {
  const { capability } = scriptedRoute(
    replies([
      { type: "provider-fallback", reason: "chatgpt-usage-limit", limitedUntil: 1_000 },
      {
        type: "done",
        message: { role: "assistant", content: "ok", tool_calls: [] },
        usage: NO_USAGE,
      },
    ]),
  );

  expect(await stream(capability, GO).result()).toMatchObject({
    diagnostics: [
      {
        type: "provider-fallback",
        details: { reason: "chatgpt-usage-limit", limitedUntil: 1_000 },
      },
    ],
  });
});

test("a route error code becomes a terminal error carrying the code", async () => {
  const { capability } = scriptedRoute(
    replies([{ type: "error", error: { code: "chatgpt-reconnect-required" } }]),
  );

  expect(await stream(capability, GO).result()).toMatchObject({
    stopReason: "error",
    errorMessage: "chatgpt-reconnect-required",
  });
});

test("a route that throws, rejects the request, or ends early still ends the stream with an error", async () => {
  const rejection: ValidationFailure = {
    ok: false,
    error: { code: "invalid-request", reason: "messages must be a non-empty array" },
  };

  const throws = scriptedRoute(() => Promise.reject(new Error("network reset")));
  const rejects = scriptedRoute(() => Promise.resolve(rejection));
  const truncated = scriptedRoute(replies([{ type: "text-delta", delta: "partial answer" }]));

  expect(await stream(throws.capability, GO).result()).toMatchObject({ stopReason: "error" });

  expect(await stream(rejects.capability, GO).result()).toMatchObject({
    stopReason: "error",
    errorMessage: rejection.error.reason,
  });

  expect(await stream(truncated.capability, GO).result()).toMatchObject({
    stopReason: "error",
    content: [{ type: "text", text: "partial answer" }],
  });
});

test("abort mid-stream ends as aborted and drops what arrives afterwards", async () => {
  const route = pushableStream();
  const { capability } = scriptedRoute(() => Promise.resolve(route.readable));
  const controller = new AbortController();
  const reply = stream(capability, GO, controller.signal);

  await route.push({ type: "text-delta", delta: "before" });

  for await (const event of reply) {
    if (event.type !== "text_delta") continue;
    controller.abort();
    await route.push({ type: "text-delta", delta: "after" }).catch(() => {
      /* the aborted reader already cancelled the stream */
    });
  }

  expect(await reply.result()).toMatchObject({
    stopReason: "aborted",
    content: [{ type: "text", text: "before" }],
  });
});

test("an abort while the route is still answering ends as aborted and cancels the stream it returns", async () => {
  const controller = new AbortController();
  let cancelled = false;

  const silent = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });

  const { capability } = scriptedRoute(() => {
    controller.abort();

    return Promise.resolve(silent);
  });

  const reply = stream(capability, GO, controller.signal);

  expect(await reply.result()).toMatchObject({ stopReason: "aborted" });
  expect(cancelled).toBe(true);
});
