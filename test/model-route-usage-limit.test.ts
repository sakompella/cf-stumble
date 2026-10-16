/// <reference types="@cloudflare/vitest-plugin/types" />

import { createExecutionContext } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import type { ChatGPTAccess } from "../src/chatgpt/index.js";
import {
  ModelRoute,
  type ModelRouteRequest,
  type StreamingProviderPayload,
} from "../src/model-route.js";
import {
  collectEvents,
  DONE_LINE,
  providerStreamOfLines,
  sseLine,
} from "./model-route-provider-stream.js";

/**
 * `ModelRoute.runStream` when the owner's ChatGPT plan meets its usage limit (ADR-0047): a call
 * refused before any output is answered by Workers AI after one `provider-fallback` event, and a
 * call refused after output is not. OpenAI is faked through the global `fetch` the route uses.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const REQUEST: ModelRouteRequest = { messages: [{ role: "user", content: "hi" }] };

/** A Workers AI binding that answers `text` and counts its calls. */
function workersAi(text: string) {
  const calls: string[] = [];

  const binding = {
    run(model: string, _input: StreamingProviderPayload): Promise<ReadableStream<Uint8Array>> {
      calls.push(model);

      return Promise.resolve(providerStreamOfLines([sseLine({ response: text }), DONE_LINE]));
    },
  };

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: the route reaches the binding only through `AI.run`.
  return { ai: binding as Ai, calls };
}

/** A route a Supervisor created, whose holder answers `access` and records each usage limit. */
function supervisedRoute(ai: Ai, access: ChatGPTAccess) {
  const limited: (readonly [string, number | null])[] = [];
  const context = createExecutionContext();
  Object.defineProperty(context, "props", { value: { supervisor: "owner" } });

  const route = new ModelRoute(context, {
    AI: ai,
    SUPERVISOR: {
      getByName: () => ({
        chatgptAccess: () => Promise.resolve(access),
        markChatGPTRefused: () => Promise.resolve(),
        markChatGPTUsageLimited: (accessToken, limitedUntil) => {
          limited.push([accessToken, limitedUntil]);

          return Promise.resolve();
        },
      }),
    },
    CHATGPT_MODEL: "gpt-test",
  });

  return { limited, events: () => eventsOf(route.runStream(REQUEST)) };
}

function eventsOf(outcome: ReturnType<ModelRoute["runStream"]>) {
  if (!(outcome instanceof ReadableStream)) throw new Error(outcome.error.reason);

  return collectEvents(outcome);
}

/** OpenAI's Responses endpoint answering HTTP 200 with these stream events. */
function responsesAnswer(events: readonly object[]) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  );
}

const USAGE_LIMIT_FAILED = {
  type: "response.failed",
  response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } },
};

const READY: ChatGPTAccess = { kind: "ready", accessToken: "chatgpt-access-FAKE-route" };

test("a usage limit before any output is answered by Workers AI after one fallback notice", async () => {
  const fetchSpy = responsesAnswer([
    { type: "response.created", response: {} },
    USAGE_LIMIT_FAILED,
  ]);

  const binding = workersAi("from Workers AI");
  const route = supervisedRoute(binding.ai, READY);

  const events = await route.events();

  expect(fetchSpy).toHaveBeenCalledOnce();
  expect(binding.calls).toEqual(["@cf/zai-org/glm-5.3-flash"]);
  expect(route.limited).toEqual([[READY.accessToken, null]]);
  expect(events.slice(0, 2)).toEqual([
    { type: "provider-fallback", reason: "chatgpt-usage-limit", limitedUntil: null },
    { type: "text-delta", delta: "from Workers AI" },
  ]);
  expect(events.slice(2)).toMatchObject([
    { type: "done", message: { content: "from Workers AI" } },
  ]);
});

test("a usage limit after output ends the call with one error and never asks Workers AI", async () => {
  responsesAnswer([{ type: "response.output_text.delta", delta: "part" }, USAGE_LIMIT_FAILED]);
  const binding = workersAi("from Workers AI");

  const events = await supervisedRoute(binding.ai, READY).events();

  expect(events).toEqual([
    { type: "text-delta", delta: "part" },
    { type: "error", error: { code: "model-unavailable" } },
  ]);
  expect(binding.calls).toEqual([]);
});

test("while a usage limit with a named end lasts, ChatGPT is not asked and the notice says when it ends", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const binding = workersAi("ok");
  const access: ChatGPTAccess = { kind: "usage-limited", limitedUntil: 1_800_000_000_000 };

  const events = await supervisedRoute(binding.ai, access).events();

  expect(fetchSpy).not.toHaveBeenCalled();
  expect(events[0]).toEqual({
    type: "provider-fallback",
    reason: "chatgpt-usage-limit",
    limitedUntil: 1_800_000_000_000,
  });
  expect(events.at(-1)).toMatchObject({ type: "done", message: { content: "ok" } });
});
