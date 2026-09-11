import { expect, test } from "vitest";
import { encodeModelRouteResponseAsStream } from "../../../src/model-route.js";
import { createRouteStreamFn, ROUTE_MODEL } from "../../../src/facet/generation-0/route-stream.js";
import type { ModelCapability } from "../../../src/facet/generation-0/index.js";
import type {
  ModelRouteRequest,
  ModelRouteResponse,
  ModelStreamEvent,
  ValidationFailure,
} from "../../../src/model-route.js";
import type { StreamFn } from "@cf-stumble/pi";

/** `@cf-stumble/pi` exports `StreamFn` but not the `Context` it receives; derive both, as
 * `route-stream.ts` itself does, rather than restating the shape here. */
type Context = Parameters<StreamFn>[1];

function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

const encoder = new TextEncoder();

/** A model stream this test pushes NDJSON events into on its own schedule, so a test can control
 * exactly what has arrived when it aborts or closes the stream. */
function pushableModelStream() {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  return {
    readable,
    push(event: ModelStreamEvent): Promise<void> {
      return writer.write(encoder.encode(`${JSON.stringify(event)}\n`));
    },
    close(): Promise<void> {
      return writer.close();
    },
  };
}

/** A `ModelCapability` whose `runStream` answers from a script and records every call. */
function fakeModel(
  answer: () => Promise<ReadableStream<Uint8Array> | ValidationFailure>,
): ModelCapability & { readonly calls: ModelRouteRequest[] } {
  const calls: ModelRouteRequest[] = [];

  return {
    calls,
    run(): Promise<ModelRouteResponse | ValidationFailure> {
      throw new Error("this test only drives the streaming path");
    },
    runStream(request: ModelRouteRequest) {
      calls.push(request);

      return answer();
    },
  };
}

const CONTEXT: Context = { messages: [{ role: "user", content: "go", timestamp: 0 }] };

test("streams incremental text and a final assembled message", async () => {
  const model = fakeModel(() =>
    Promise.resolve(
      encodeModelRouteResponseAsStream({
        ok: true,
        message: { role: "assistant", content: "Hello there", tool_calls: [] },
      }),
    ),
  );

  const stream = await createRouteStreamFn(model)(ROUTE_MODEL, CONTEXT);
  const events: string[] = [];

  for await (const event of stream) events.push(event.type);
  expect(events).toContain("start");
  expect(events.at(-1)).toBe("done");
  const finalMessage = await stream.result();
  expect(finalMessage).toMatchObject({
    stopReason: "stop",
    content: [{ type: "text", text: "Hello there" }],
  });
  expect(model.calls).toHaveLength(1);
});

test("streams a tool call and assembles its parsed arguments", async () => {
  const model = fakeModel(() =>
    Promise.resolve(
      encodeModelRouteResponseAsStream({
        ok: true,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", function: { name: "bash", arguments: '{"cmd":"ls"}' } }],
        },
      }),
    ),
  );

  const stream = await createRouteStreamFn(model)(ROUTE_MODEL, CONTEXT);

  for await (const event of stream) {
    void event;
  }

  const finalMessage = await stream.result();
  expect(finalMessage).toMatchObject({
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { cmd: "ls" } }],
  });
});

test("rejects a conversation holding non-text content before ever calling the model", async () => {
  const model = fakeModel(() => Promise.reject(new Error("must not be called")));

  const imageContext: Context = {
    messages: [
      {
        role: "user",
        content: [{ type: "image", data: "AAA", mimeType: "image/png" }],
        timestamp: 0,
      },
    ],
  };

  const stream = await createRouteStreamFn(model)(ROUTE_MODEL, imageContext);
  const finalMessage = await stream.result();
  expect(finalMessage).toMatchObject({ stopReason: "error" });
  expect(model.calls).toHaveLength(0);
});

test("a model-route validation failure becomes an error event with its reason", async () => {
  const rejection: ValidationFailure = {
    ok: false,
    error: { code: "invalid-request", reason: "messages must be a non-empty array" },
  };

  const model = fakeModel(() => Promise.resolve(rejection));
  const stream = await createRouteStreamFn(model)(ROUTE_MODEL, CONTEXT);
  const finalMessage = await stream.result();
  expect(finalMessage).toMatchObject({
    stopReason: "error",
    errorMessage: "messages must be a non-empty array",
  });
});

test("a provider stream that ends mid-turn without a result fails the turn but keeps the partial text", async () => {
  const pushable = pushableModelStream();
  const model = fakeModel(() => Promise.resolve(pushable.readable));
  const stream = await createRouteStreamFn(model)(ROUTE_MODEL, CONTEXT);

  await pushable.push({ type: "text-delta", delta: "partial answer" });
  await pushable.close();

  const finalMessage = await stream.result();
  expect(finalMessage).toMatchObject({
    stopReason: "error",
    content: [{ type: "text", text: "partial answer" }],
  });
});

test("an already-aborted signal stops the model from being called at all", async () => {
  const controller = new AbortController();
  controller.abort();
  const model = fakeModel(() => Promise.reject(new Error("must not be called")));
  const stream = await createRouteStreamFn(model, controller.signal)(ROUTE_MODEL, CONTEXT);
  const finalMessage = await stream.result();
  expect(finalMessage).toMatchObject({ stopReason: "aborted" });
  expect(model.calls).toHaveLength(0);
});

test("aborting mid-stream releases the reader and stops applying further events", async () => {
  const pushable = pushableModelStream();
  const controller = new AbortController();
  const model = fakeModel(() => Promise.resolve(pushable.readable));
  const stream = await createRouteStreamFn(model, controller.signal)(ROUTE_MODEL, CONTEXT);

  const seen: string[] = [];

  const draining = (async () => {
    for await (const event of stream) seen.push(event.type);
  })();

  await pushable.push({ type: "text-delta", delta: "before abort" });
  await tick();
  controller.abort();
  await tick();
  // Pushed after the abort: must never reach the assistant's assembled content.
  await pushable.push({ type: "text-delta", delta: "after abort" }).catch(() => {
    /* the writer may already be closed by the aborted reader; that is fine here */
  });

  await draining;
  const finalMessage = await stream.result();
  expect(finalMessage.stopReason).toBe("aborted");
  expect(finalMessage.content).toEqual([{ type: "text", text: "before abort" }]);
  expect(model.calls).toHaveLength(1);
});

test("a provider call that throws synchronously becomes a single error event", async () => {
  const model = fakeModel(() => {
    throw new Error("network reset");
  });

  const stream = await createRouteStreamFn(model)(ROUTE_MODEL, CONTEXT);
  const finalMessage = await stream.result();
  expect(finalMessage).toMatchObject({ stopReason: "error" });
});
