import * as Effect from "effect/Effect";
import { afterEach, expect, test, vi } from "vitest";
import { chatgptTurn, type ChatGPTCredential } from "../../src/chatgpt/index.js";
import type { ModelRouteRequest, ModelStreamEvent } from "../../src/model-route.js";
import { capturedEvents, everythingLogged, named } from "../log-capture.js";
import {
  ACCESS_ONE,
  fakeCredential,
  ready,
  recordingFetch,
  responsesEvent,
  sseResponse,
  type RecordedCall,
} from "./fixtures.js";

/**
 * A ChatGPT call that the plan's usage limit refuses (ADR-0047): before any output it is the typed
 * failure the route answers from Workers AI, after output it fails as any provider error does, and
 * the log names the provider's status, error type and code without its message.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const REQUEST: ModelRouteRequest = { messages: [{ role: "user", content: "Read a.txt" }] };

/** How one call ended, read without the route's stream, so the case the route falls back on shows. */
async function outcomeOf(
  credential: ChatGPTCredential,
  reply: (call: RecordedCall) => Promise<Response>,
) {
  const { fetcher, calls } = recordingFetch(reply);
  const emitted: ModelStreamEvent[] = [];

  const outcome = await Effect.runPromise(
    chatgptTurn(
      { credential, fetcher, model: "gpt-test" },
      REQUEST,
    )((event) => {
      emitted.push(event);
    }).pipe(
      Effect.as({ kind: "answered" } as const),
      Effect.catchTags({
        ChatGPTUsageLimited: ({ limitedUntil }) =>
          Effect.succeed({ kind: "usage-limited", limitedUntil } as const),
        ModelTurnFailed: ({ code }) => Effect.succeed({ kind: "failed", code } as const),
        ChatGPTNotConnected: () => Effect.succeed({ kind: "not-connected" } as const),
      }),
    ),
  );

  return { outcome, emitted, calls };
}

const USAGE_LIMIT_FAILED = responsesEvent({
  type: "response.failed",
  response: {
    error: {
      code: "subscription_sharing_usage_limit_exceeded",
      message: "owner@example.com reached the Plus limit",
    },
  },
});

test("a usage limit in the stream before any output is the typed failure the route falls back on", async () => {
  const credential = fakeCredential([ready(ACCESS_ONE)]);
  const logged = capturedEvents();

  const { outcome, emitted } = await outcomeOf(credential, () =>
    Promise.resolve(
      sseResponse([responsesEvent({ type: "response.created", response: {} }), USAGE_LIMIT_FAILED]),
    ),
  );

  expect(outcome).toEqual({ kind: "usage-limited", limitedUntil: null });
  expect(emitted).toEqual([]);
  expect(credential.limited).toEqual([null]);
  expect(credential.refused).toEqual([]);
  expect(named(logged(), "chatgpt.model-call")).toEqual([
    expect.objectContaining({
      outcome: "stream-failed",
      status: 200,
      type: "unknown",
      code: "subscription_sharing_usage_limit_exceeded",
      fallback: true,
    }),
  ]);
  expect(everythingLogged()).not.toContain("owner@example.com");
  expect(everythingLogged()).not.toMatch(/chatgpt-access-FAKE/u);
});

test("a usage limit after output errors the call as before, and the limit is still recorded", async () => {
  const credential = fakeCredential([ready(ACCESS_ONE)]);
  const logged = capturedEvents();

  const { outcome, emitted } = await outcomeOf(credential, () =>
    Promise.resolve(
      sseResponse([
        responsesEvent({ type: "response.output_text.delta", delta: "part" }),
        USAGE_LIMIT_FAILED,
      ]),
    ),
  );

  expect(outcome).toEqual({ kind: "failed", code: "model-unavailable" });
  expect(emitted).toEqual([{ type: "text-delta", delta: "part" }]);
  expect(credential.limited).toEqual([null]);
  expect(named(logged(), "chatgpt.model-call")).toEqual([
    expect.objectContaining({ outcome: "stream-failed", fallback: false }),
  ]);
});

test("an HTTP 429 records when its Retry-After says the limit ends, and logs status, type and code only", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  const credential = fakeCredential([ready(ACCESS_ONE)]);
  const logged = capturedEvents();

  const { outcome } = await outcomeOf(credential, () =>
    Promise.resolve(
      Response.json(
        {
          error: {
            type: "invalid_request_error",
            code: "subscription_sharing_usage_limit_exceeded",
            message: "owner@example.com reached the Plus limit",
          },
        },
        { status: 429, headers: { "retry-after": "120" } },
      ),
    ),
  );

  expect(outcome).toEqual({ kind: "usage-limited", limitedUntil: 1_800_000_120_000 });
  expect(credential.limited).toEqual([1_800_000_120_000]);
  expect(named(logged(), "chatgpt.model-call")).toEqual([
    expect.objectContaining({
      outcome: "http-error",
      status: 429,
      type: "invalid_request_error",
      code: "subscription_sharing_usage_limit_exceeded",
      fallback: true,
      limitedUntil: 1_800_000_120_000,
    }),
  ]);
  expect(everythingLogged()).not.toContain("owner@example.com");
});

test.each([
  ["a rate limit in the stream", 200, { type: "error", code: "rate_limit_exceeded", message: "m" }],
  [
    "exhausted quota in the stream",
    200,
    { type: "error", error: { type: "insufficient_quota", code: null, message: "m" } },
  ],
  ["an HTTP 429 with no error object", 429, { detail: "slow down" }],
] as const)("%s is a usage limit too", async (_name, status, payload) => {
  const credential = fakeCredential([ready(ACCESS_ONE)]);

  const { outcome } = await outcomeOf(credential, () =>
    Promise.resolve(
      status === 200
        ? sseResponse([`data: ${JSON.stringify(payload)}\n\n`])
        : Response.json(payload, { status }),
    ),
  );

  expect(outcome).toEqual({ kind: "usage-limited", limitedUntil: null });
});

test("a connection still inside its usage limit sends nothing", async () => {
  const { outcome, calls } = await outcomeOf(
    fakeCredential([{ kind: "usage-limited", limitedUntil: 5_000 }]),
    () => Promise.reject(new Error("must not be called")),
  );

  expect(outcome).toEqual({ kind: "usage-limited", limitedUntil: 5_000 });
  expect(calls).toEqual([]);
});

test("a refusal that is not a limit logs its status, type and code and errors the call", async () => {
  const credential = fakeCredential([ready(ACCESS_ONE)]);
  const logged = capturedEvents();

  const { outcome } = await outcomeOf(credential, () =>
    Promise.resolve(
      Response.json(
        {
          error: {
            type: "invalid_request_error",
            code: "subscription_sharing_user_not_eligible",
            message: "owner@example.com is not eligible",
          },
        },
        { status: 403 },
      ),
    ),
  );

  expect(outcome).toEqual({ kind: "failed", code: "model-unavailable" });
  expect(credential.limited).toEqual([]);
  const [logLine] = named(logged(), "chatgpt.model-call");
  expect(logLine).toMatchObject({
    outcome: "http-error",
    status: 403,
    type: "invalid_request_error",
    code: "subscription_sharing_user_not_eligible",
  });
  expect(logLine).not.toHaveProperty("fallback");
  expect(everythingLogged()).not.toContain("owner@example.com");
});
