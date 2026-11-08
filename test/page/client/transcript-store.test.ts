import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { afterEach, expect, test, vi } from "vitest";
import { loadIntoTranscript } from "../../../src/page/client/transcript-store.js";
import { viewReader } from "../../../src/page/client/view-reader.js";
import type { Conversation } from "../../../src/page/client/conversation.js";
import { Message } from "../../../src/page/client/message.js";
import { init, update } from "../../../src/page/client/update.js";
import { openedTranscript } from "./transcript-resource.js";
import { received, viewing } from "./views.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function entry(id: number, conversationId = 1) {
  return {
    id,
    conversationId,
    kind: "pi.user",
    model: [{ role: "user", content: `message ${id}` }],
  };
}

function viewLine(conversationId: number, entries: readonly object[], before?: number): string {
  const view = { conversation: { id: conversationId }, entries, before, docs: {} };

  return JSON.stringify([["r", view]]);
}

function ids(conversation: Option.Option<Conversation>): readonly number[] {
  return Option.match(conversation, {
    onNone: () => [],
    onSome: ({ items }) => items.flatMap((item) => (item.kind === "entry" ? [item.entry.id] : [])),
  });
}

test("earlier messages load from the entries page the Worker sends", async () => {
  vi.stubGlobal("fetch", () =>
    Promise.resolve(Response.json({ items: [entry(9), entry(8)], next: { after: 8 } })),
  );

  const { held, provide } = openedTranscript();

  viewReader(held)(viewLine(1, [entry(10)], 9));

  const loaded = Option.getOrUndefined(await Effect.runPromise(provide(loadIntoTranscript())));

  expect(loaded?.items.map((item) => (item.kind === "entry" ? item.entry.id : item.kind))).toEqual([
    "earlier",
    8,
    9,
    10,
  ]);
});

test("a tab whose conversation was replaced starts its transcript over, and a late history load is dropped", async () => {
  let answer: ((response: Response) => void) | undefined;

  vi.stubGlobal(
    "fetch",
    () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
  );

  const { held, provide } = openedTranscript();

  expect(ids(viewReader(held)(viewLine(1, [entry(10)], 9)))).toEqual([10]);

  const loading = Effect.runPromise(provide(loadIntoTranscript()));

  await vi.waitFor(() => {
    expect(answer).toBeDefined();
  });

  const reconnected = viewReader(held)(viewLine(2, []));

  expect(ids(reconnected)).toEqual([]);

  answer?.(Response.json({ items: [entry(8), entry(9)] }));
  await expect(loading).resolves.toEqual(Option.none());
  expect(ids(viewReader(held)(viewLine(2, [entry(20, 2)])))).toEqual([20]);
});

test("a page showing a replaced conversation drops the old one's unsent messages and note", () => {
  const listed = update(init().model, Message.SucceededFetchProjects({ projects: [] })).model;

  const old = update(listed, received(listed, viewing({ maybeId: Option.some(1) }))).model;

  const unsent = {
    ...old,
    runNote: "stopped: aborted",
    outbox: [{ requestId: "r", text: "hi", maybeSubmissionId: Option.none(), afterEntry: 0 }],
  };

  const replaced = update(unsent, received(unsent, viewing({ maybeId: Option.some(2) }))).model;

  expect(replaced.outbox).toEqual([]);
  expect(replaced.runNote).toBe("");
});
