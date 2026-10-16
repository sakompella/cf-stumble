import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { afterEach, expect, test, vi } from "vitest";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { subscriptions } from "../../../src/page/client/turn.js";
import { init, update } from "../../../src/page/client/update.js";

/**
 * The turn's stream is a Foldkit Subscription: the runtime recomputes its dependencies after every
 * update, restarts the stream when they change, and interrupts it when they become none. So the
 * dependencies must stay equal for the whole turn, or every frame would send the prompt again, and
 * they must end when the reader leaves the project, or the old turn would keep its response open.
 */

const PROJECTS = [
  { id: "repo", displayName: "hello-world", isHarness: false, location: "https://github.com/o/r" },
  { id: "harness", displayName: "harness", isHarness: true, location: "/workspace/harness" },
];

const turn = subscriptions["turn"];

if (turn === undefined) {
  throw new Error("the page has no turn subscription");
}

const sameDependencies = Schema.toEquivalence(turn.dependenciesSchema);

function after(start: Model, messages: readonly Message[]): Model {
  return messages.reduce((model, message) => update(model, message).model, start);
}

function streamingPage(): Model {
  return after(init().model, [
    Message.SucceededFetchProjects({ projects: PROJECTS }),
    Message.UpdatedPrompt({ value: "do it" }),
    Message.ClickedSendTurn(),
  ]);
}

test("the turn's dependencies stay equal while its frames arrive", () => {
  const start = streamingPage();
  const turnId = start.turnCount;

  const frame = (value: Parameters<typeof Message.ReceivedTurnFrame>[0]["frame"]) =>
    Message.ReceivedTurnFrame({ turnId, frame: value });

  const frames = [
    frame({ kind: "text", text: "Hel" }),
    frame({ kind: "tool-start", toolCallId: "t1", toolName: "read", arguments: {} }),
    frame({
      kind: "tool-result",
      toolCallId: "t1",
      toolName: "read",
      isError: false,
      content: "ok",
      truncated: false,
    }),
    frame({ kind: "diff", content: "@@", truncated: false }),
    frame({ kind: "saved", revision: 4, messageCount: 2 }),
    Message.UpdatedPrompt({ value: "typing the next prompt" }),
  ];

  const started = turn.modelToDependencies(start);
  let model = start;

  expect(Option.isSome(started.maybeRequest)).toBe(true);

  for (const message of frames) {
    model = update(model, message).model;

    expect(sameDependencies(turn.modelToDependencies(model), started), message._tag).toBe(true);
  }
});

test("leaving the project, cancelling, or the stream's end stops the turn's stream", () => {
  const start = streamingPage();
  const turnId = start.turnCount;

  const endings = [
    Message.ClickedProject({ projectId: "harness" }),
    Message.ClickedProject({ projectId: "repo" }),
    Message.ClickedCancelTurn(),
    Message.EndedTurnStream({ turnId }),
    Message.RefusedTurn({ turnId, wording: "busy" }),
    Message.DisconnectedTurnStream({ turnId, detail: "x" }),
  ];

  for (const ending of endings) {
    const ended = update(start, ending).model;

    expect(Option.isNone(turn.modelToDependencies(ended).maybeRequest), ending._tag).toBe(true);
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("stopping the turn's stream aborts its request and cancels the response body", async () => {
  const seen = { aborted: false, bodyCancelled: false };

  vi.stubGlobal("fetch", (_input: RequestInfo | URL, requestInit?: RequestInit) => {
    requestInit?.signal?.addEventListener("abort", () => {
      seen.aborted = true;
    });

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"kind":"text","text":"Hel"}\n'));
      },
      cancel() {
        seen.bodyCancelled = true;
      },
    });

    return Promise.resolve(
      new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } }),
    );
  });

  const dependencies = turn.modelToDependencies(streamingPage());
  const firstFrame = Effect.runFork(turn.dependenciesToStream(dependencies).pipe(Stream.runHead));
  const first = await Effect.runPromise(Fiber.join(firstFrame));

  expect(Option.map(first, (message) => message._tag)).toEqual(Option.some("ReceivedTurnFrame"));

  // The body stays open, as a running turn's does. Foldkit interrupts the stream when its
  // dependencies end; `runHead` interrupts it after the first Message in the same way.
  expect(seen).toEqual({ aborted: true, bodyCancelled: true });
});

test("the page reads past keepalive lines and sees only the turn's frames", async () => {
  const body = '\n{"kind":"text","text":"Hel"}\n\n\n{"kind":"text","text":"lo"}\n\n';

  vi.stubGlobal("fetch", () =>
    Promise.resolve(
      new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } }),
    ),
  );

  const dependencies = turn.modelToDependencies(streamingPage());

  const messages = await Effect.runPromise(
    Stream.runCollect(turn.dependenciesToStream(dependencies)),
  );

  expect([...messages].map((message) => message._tag)).toEqual([
    "ReceivedTurnFrame",
    "ReceivedTurnFrame",
    "EndedTurnStream",
  ]);
});
