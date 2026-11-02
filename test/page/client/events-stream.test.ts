import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { afterEach, expect, test, vi } from "vitest";
import { subscriptions } from "../../../src/page/client/events-stream.js";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { init, update } from "../../../src/page/client/update.js";

const PROJECTS = [
  { id: "repo", displayName: "hello-world", isHarness: false, location: "https://github.com/o/r" },
  { id: "harness", displayName: "harness", isHarness: true, location: "/workspace/harness" },
];

const events = subscriptions["events"];

if (events === undefined) {
  throw new Error("the page has no events subscription");
}

const sameDependencies = Schema.toEquivalence(events.dependenciesSchema);

const SNAPSHOT = '{"type":"snapshot","entries":[],"tools":[],"inbox":[],"agent":{}}';

function after(start: Model, messages: readonly Message[]): Model {
  return messages.reduce((model, message) => update(model, message).model, start);
}

function listedPage(): Model {
  return after(init().model, [Message.SucceededFetchProjects({ projects: PROJECTS })]);
}

function ndjson(body: string): Promise<Response> {
  return Promise.resolve(
    new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("the stream's dependencies stay equal while the conversation runs, the reader sends and clicks its project again", () => {
  const start = listedPage();
  const streamId = start.eventsStreamId;
  const opened = events.modelToDependencies(start);

  const messages = [
    Message.ReceivedEvent({ streamId, event: { type: "run_start", inputs: [1] } }),
    Message.UpdatedPrompt({ value: "follow up" }),
    Message.ClickedSendTurn(),
    Message.MintedRequestId({ projectId: "repo", requestId: "r", content: "follow up" }),
    Message.SucceededSend({ requestId: "r", submissionId: 2 }),
    Message.ClickedProject({ projectId: "repo" }),
    Message.DisconnectedEvents({ streamId, detail: "the stream ended" }),
    Message.ReceivedEvent({ streamId, event: { type: "run_end", inputs: [1] } }),
  ];

  let model = start;

  for (const message of messages) {
    model = update(model, message).model;

    expect(sameDependencies(events.modelToDependencies(model), opened), message._tag).toBe(true);
  }
});

test("leaving the project or starting a fresh thread opens another stream", () => {
  const start = listedPage();
  const opened = events.modelToDependencies(start);

  const changes = [
    Message.ClickedProject({ projectId: "harness" }),
    Message.SucceededFreshThread({ streamId: start.eventsStreamId }),
  ];

  for (const change of changes) {
    const changed = events.modelToDependencies(update(start, change).model);

    expect(sameDependencies(changed, opened), change._tag).toBe(false);
  }

  expect(Option.isNone(events.modelToDependencies(init().model).maybeStream)).toBe(true);
});

test("stopping the stream aborts its request and cancels the response body", async () => {
  const seen = { aborted: false, bodyCancelled: false };

  vi.stubGlobal("fetch", (_input: RequestInfo | URL, requestInit?: RequestInit) => {
    requestInit?.signal?.addEventListener("abort", () => {
      seen.aborted = true;
    });

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${SNAPSHOT}\n`));
      },
      cancel() {
        seen.bodyCancelled = true;
      },
    });

    return Promise.resolve(
      new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } }),
    );
  });

  const dependencies = events.modelToDependencies(listedPage());
  const firstEvent = Effect.runFork(events.dependenciesToStream(dependencies).pipe(Stream.runHead));
  const first = await Effect.runPromise(Fiber.join(firstEvent));

  expect(Option.map(first, (message) => message._tag)).toEqual(Option.some("ReceivedEvent"));
  expect(seen).toEqual({ aborted: true, bodyCancelled: true });
});

test("the page reads past blank lines and events it does not show, and reconnects when the stream ends", async () => {
  const paths: string[] = [];

  vi.stubGlobal("fetch", (path: string) => {
    paths.push(path);

    return ndjson(`\n${SNAPSHOT}\n\n{"type":"turn_start"}\n{"type":"run_start","inputs":[1]}\n`);
  });

  const dependencies = events.modelToDependencies(listedPage());

  const messages = await Effect.runPromise(
    Stream.runCollect(events.dependenciesToStream(dependencies).pipe(Stream.take(4))),
  );

  expect([...messages].map((message) => message._tag)).toEqual([
    "ReceivedEvent",
    "ReceivedEvent",
    "DisconnectedEvents",
    "ReceivedEvent",
  ]);
  expect(paths).toEqual(["/api/projects/repo/events", "/api/projects/repo/events"]);
});

test("a refused stream says why, and a line it cannot read is reported", async () => {
  vi.stubGlobal("fetch", () =>
    Promise.resolve(
      Response.json({ ok: false, problem: { code: "no-active-generation" } }, { status: 503 }),
    ),
  );

  const dependencies = events.modelToDependencies(listedPage());

  const refused = await Effect.runPromise(
    events.dependenciesToStream(dependencies).pipe(Stream.runHead),
  );

  expect(refused).toEqual(
    Option.some(Message.RefusedEvents({ streamId: 1, wording: "rejected: no-active-generation" })),
  );

  vi.stubGlobal("fetch", () => ndjson('{"type":"message_end","entry":3}\nnot json\n'));

  const unreadable = await Effect.runPromise(
    Stream.runCollect(events.dependenciesToStream(dependencies).pipe(Stream.take(2))),
  );

  expect([...unreadable].map((message) => message._tag)).toEqual([
    "ReceivedUnreadableEvent",
    "ReceivedUnreadableEvent",
  ]);
});
