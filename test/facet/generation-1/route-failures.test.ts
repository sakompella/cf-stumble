import { createExecutionContext, reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { GENERATION_REPLACED } from "../../../src/generation-replaced.js";
import type { ModelStreamEvent, WorkersAiBinding } from "../../../src/model-route-wire/events.js";
import { ModelRoute } from "../../../src/model-route.js";
import { DONE_LINE, providerStreamOfLines, sseLine } from "../../model-route-provider-stream.js";
import { eventually } from "../../eventually.js";
import { entriesText } from "./conversation-host.js";
import { inTurn } from "./route-failure-turn.js";
import { NO_USAGE, replies, scriptedRoute, type Answer } from "./scripted-route.js";

afterEach(async () => {
  await reset();
});

const encoder = new TextEncoder();
const text = (delta: string): ModelStreamEvent => ({ type: "text-delta", delta });

const ANSWER: Answer = replies([
  {
    type: "done",
    served: { provider: "workers-ai", model: "test-model" },
    message: { role: "assistant", content: "hi", tool_calls: [] },
    usage: NO_USAGE,
  },
]);

function lineStream(
  events: readonly ModelStreamEvent[],
  end: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
): Answer {
  return () =>
    Promise.resolve(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          }

          end(controller);
        },
      }),
    );
}

const refused =
  (reason: string): Answer =>
  () =>
    Promise.resolve({ ok: false, error: { code: "invalid-request", reason } });

test.each([
  { fault: "a runStream call that rejects", first: () => Promise.reject(new Error("rpc broke")) },
  {
    fault: "a stream that errors mid-way",
    first: lineStream([text("par")], (controller) => {
      controller.error(new Error("stream broke"));
    }),
  },
  {
    fault: "a stream that closes with no result",
    first: lineStream([text("par")], (controller) => {
      controller.close();
    }),
  },
] satisfies ReadonlyArray<{ fault: string; first: Answer }>)(
  "Pi retries after $fault and the turn answers",
  async ({ first }) => {
    const { requests, capability } = scriptedRoute(first, ANSWER);

    await inTurn("route-failure-retried", capability, async ({ facet, id, reports }) => {
      await eventually(async () => {
        expect((await entriesText(facet, id)).includes('"hi"')).toBe(true);
      });
      expect(requests).toHaveLength(2);
      expect(reports).not.toContain("model_error");
    });
  },
  15_000,
);

test("a Supervisor admission that rejects once is retried by Pi and the turn answers", async () => {
  let admissions = 0;

  const ai: WorkersAiBinding = {
    run: () => Promise.resolve(providerStreamOfLines([sseLine({ response: "hi" }), DONE_LINE])),
  };

  const context = createExecutionContext();
  Object.defineProperty(context, "props", { value: { supervisor: "owner", instance: 0 } });

  const route = new ModelRoute(context, {
    AI: ai,
    SUPERVISOR: {
      getByName: () => ({
        admitModelTurn: () => {
          admissions += 1;

          return admissions === 1
            ? Promise.reject(new Error("the supervisor is overloaded"))
            : Promise.resolve(true);
        },
        chatgptAccess: () => Promise.resolve({ kind: "not-connected" }),
        markChatGPTRefused: () => Promise.resolve(),
        markChatGPTUsageLimited: () => Promise.resolve(),
      }),
    },
    CHATGPT_MODEL: "gpt-test",
  });

  await inTurn(
    "route-failure-admission",
    { runStream: (request) => route.runStream(request) },
    async ({ facet, id, reports }) => {
      await eventually(async () => {
        expect((await entriesText(facet, id)).includes('"hi"')).toBe(true);
      });
      expect(admissions).toBe(2);
      expect(reports).not.toContain("model_error");
    },
  );
}, 15_000);

test.each([
  { fault: "a malformed-request refusal", answer: refused("messages must be a non-empty array") },
  { fault: "a replaced-generation refusal", answer: refused(GENERATION_REPLACED) },
  {
    fault: "an unknown event line",
    answer: () => Promise.resolve(new Blob(['{"type":"mystery"}\n']).stream()),
  },
] satisfies ReadonlyArray<{ fault: string; answer: Answer }>)(
  "$fault ends the run as a model error after one request",
  async ({ answer }) => {
    const { requests, capability } = scriptedRoute(answer, ANSWER);

    await inTurn("route-failure-terminal", capability, async ({ reports }) => {
      await eventually(() => {
        expect(reports).toContain("model_error");
      });
      expect(requests).toHaveLength(1);
    });
  },
);
