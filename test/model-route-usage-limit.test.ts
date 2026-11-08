import { createExecutionContext } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import type { CodexLoginAccess } from "../src/codex-login/index.js";
import type { WorkersAiBinding } from "../src/model-route-events.js";
import { ModelRoute, type ModelRouteRequest } from "../src/model-route.js";
import {
  collectEvents,
  DONE_LINE,
  providerStreamOfLines,
  sseLine,
} from "./model-route-provider-stream.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const REQUEST: ModelRouteRequest = { messages: [{ role: "user", content: "hi" }] };

function workersAi(text: string) {
  const calls: string[] = [];

  const binding: WorkersAiBinding = {
    run(model) {
      calls.push(model);

      return Promise.resolve(providerStreamOfLines([sseLine({ response: text }), DONE_LINE]));
    },
  };

  return { ai: binding, calls };
}

function supervisedRoute(ai: WorkersAiBinding, access: CodexLoginAccess) {
  const limited: (readonly [string, number | null])[] = [];
  const context = createExecutionContext();
  Object.defineProperty(context, "props", { value: { supervisor: "owner", instance: 0 } });

  const route = new ModelRoute(context, {
    AI: ai,
    SUPERVISOR: {
      getByName: () => ({
        admitModelTurn: () => Promise.resolve(true),
        codexLoginAccess: () => Promise.resolve(access),
        markCodexLoginRefused: () => Promise.resolve(),
        markCodexLoginUsageLimited: (accessToken, limitedUntil) => {
          limited.push([accessToken, limitedUntil]);

          return Promise.resolve();
        },
      }),
    },
    CHATGPT_MODEL: "gpt-test",
  });

  return { limited, events: () => eventsOf(route.runStream(REQUEST)) };
}

async function eventsOf(pending: ReturnType<ModelRoute["runStream"]>) {
  const outcome = await pending;

  if (!(outcome instanceof ReadableStream)) throw new Error(outcome.error.reason);

  return collectEvents(outcome);
}

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

const READY: CodexLoginAccess = { kind: "ready", accessToken: "codex-login-access-FAKE-route" };

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
    {
      type: "error",
      error: { code: "model-unavailable", detail: "subscription_sharing_usage_limit_exceeded" },
    },
  ]);
  expect(binding.calls).toEqual([]);
});

test("while a usage limit with a named end lasts, Codex is not asked and the notice says when it ends", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const binding = workersAi("ok");
  const access: CodexLoginAccess = { kind: "usage-limited", limitedUntil: 1_800_000_000_000 };

  const events = await supervisedRoute(binding.ai, access).events();

  expect(fetchSpy).not.toHaveBeenCalled();
  expect(events[0]).toEqual({
    type: "provider-fallback",
    reason: "chatgpt-usage-limit",
    limitedUntil: 1_800_000_000_000,
  });
  expect(events.at(-1)).toMatchObject({ type: "done", message: { content: "ok" } });
});
