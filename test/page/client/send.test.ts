import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect, test, vi } from "vitest";
import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { init, update } from "../../../src/page/client/update.js";
import { openedTranscript } from "./transcript-resource.js";
import { promptShown, runShown, shownText, streamShown, whoShown } from "./shown.js";
import { received, running, viewing } from "./views.js";

const transcript = openedTranscript();

const SentBody = Schema.Struct({
  requestId: Schema.String,
  content: Schema.String,
  budgetMinutes: Schema.Number,
});

const sentBody = Schema.decodeUnknownSync(Schema.fromJsonString(SentBody));

type Sent = typeof SentBody.Type & Readonly<{ path: string }>;

type UpdateResult = ReturnType<typeof update>;

type Commands = NonNullable<UpdateResult["commands"]>;

const PROJECTS = [
  { id: "repo", displayName: "hello-world", isHarness: false, location: "https://github.com/o/r" },
];

function sentFromPrompt(text: string, conversation = viewing()): UpdateResult {
  const listed = update(init().model, Message.SucceededFetchProjects({ projects: PROJECTS })).model;
  const ready = update(listed, received(listed, conversation)).model;
  const typed = update(ready, Message.UpdatedPrompt({ value: text })).model;

  return update(typed, Message.ClickedSendTurn());
}

async function ran(model: Model, commands: Commands): Promise<Model> {
  const [command, ...rest] = commands;

  if (command === undefined) return model;

  const next = update(model, await Effect.runPromise(transcript.provide(command.effect)));

  return ran(next.model, [...rest, ...(next.commands ?? [])]);
}

async function settled(
  { model, commands }: UpdateResult,
  answer: () => Promise<Response>,
): Promise<{ model: Model; sent: readonly Sent[] }> {
  const sent: Sent[] = [];

  vi.stubGlobal("fetch", (path: string, request?: RequestInit) => {
    sent.push({ path, ...sentBody(request?.body) });

    return answer();
  });

  return { model: await ran(model, commands ?? []), sent };
}

const accepted = () =>
  Promise.resolve(Response.json({ ok: true, submissionId: 7 }, { status: 202 }));

const problem = (code: string, status: number) => () =>
  Promise.resolve(Response.json({ ok: false, problem: { code } }, { status }));

test("sending posts the trimmed prompt once under a new request id with the run budget, and empties the prompt", async () => {
  const { model, sent } = await settled(sentFromPrompt("  do it  "), accepted);

  expect(sent.map((request) => [request.path, request.content, request.budgetMinutes])).toEqual([
    ["/api/projects/repo/messages", "do it", 30],
  ]);
  expect(sent[0]?.requestId).toMatch(/.+/u);
  expect(promptShown(model)).toBe("");
  expect(whoShown(model)).toEqual(["you · queued"]);
});

test("a send the Worker answers with 503 stays in the conversation as not confirmed, and retrying posts the same request id", async () => {
  const lost = await settled(sentFromPrompt("do it"), problem("generation-failed", 503));

  expect(whoShown(lost.model)).toEqual(["you · not confirmed"]);
  expect(promptShown(lost.model)).toBe("");

  const requestId = lost.sent[0]?.requestId ?? "";

  const retried = await settled(
    update(lost.model, Message.ClickedRetrySend({ requestId })),
    accepted,
  );

  expect(retried.sent.map((sent) => sent.requestId)).toEqual([requestId]);
  expect(whoShown(retried.model)).toEqual(["you · queued"]);
});

test("a send the Worker refuses with 4xx comes back to the prompt and cannot be retried", async () => {
  const refused = await settled(sentFromPrompt("do it"), problem("workspace-busy", 409));

  expect(whoShown(refused.model)).toEqual([]);
  expect(promptShown(refused.model)).toBe("do it");

  const requestId = refused.sent[0]?.requestId ?? "";

  expect(update(refused.model, Message.ClickedRetrySend({ requestId })).commands ?? []).toEqual([]);
});

test("a send that never got an answer is not confirmed either, and the page says why", async () => {
  const failed = await settled(sentFromPrompt("do it"), () => Promise.reject(new Error("offline")));

  expect(whoShown(failed.model)).toEqual(["you · not confirmed"]);
  expect(shownText(failed.model, ID.pageError)).toContain("offline");
});

test("a send the Worker accepted with an answer the page cannot read stays in the conversation as not confirmed, and retrying posts the same request id", async () => {
  const unreadable = await settled(sentFromPrompt("do it"), () =>
    Promise.resolve(Response.json({ ok: true, queued: "yes" }, { status: 202 })),
  );

  expect(whoShown(unreadable.model)).toEqual(["you · not confirmed"]);
  expect(promptShown(unreadable.model)).toBe("");

  const requestId = unreadable.sent[0]?.requestId ?? "";

  const retried = await settled(
    update(unreadable.model, Message.ClickedRetrySend({ requestId })),
    accepted,
  );

  expect(retried.sent.map((sent) => sent.requestId)).toEqual([requestId]);
  expect(whoShown(retried.model)).toEqual(["you · queued"]);
});

test("a send the Worker refuses because no generation is active stays retryable and the page says so, not that the Worker was unreachable", async () => {
  const refused = await settled(sentFromPrompt("do it"), problem("no-active-generation", 503));

  expect(whoShown(refused.model)).toEqual(["you · not confirmed"]);
  expect(shownText(refused.model, ID.pageError)).toContain("No generation is active");
  expect(shownText(refused.model, ID.pageError)).not.toContain("could not reach");
});

const offline = () => Promise.reject(new Error("Failed to fetch"));

test("a send lost while the stream was down is sent again, once, under its own request id, when the stream returns", async () => {
  const lost = await settled(sentFromPrompt("do it"), offline);
  const requestId = lost.sent[0]?.requestId ?? "";

  const dropped = update(
    lost.model,
    Message.DisconnectedEvents({ streamId: lost.model.eventsStreamId, detail: "x" }),
  ).model;

  expect(update(lost.model, received(lost.model, viewing())).commands ?? []).toEqual([]);

  const back = await settled(update(dropped, received(dropped, viewing())), accepted);

  expect(back.sent.map((sent) => sent.requestId)).toEqual([requestId]);
  expect(whoShown(back.model)).toEqual(["you · queued"]);
});

test("a send lost offline is sent again when the browser is back online, and the page says offline meanwhile", async () => {
  const lost = await settled(sentFromPrompt("do it"), offline);
  const requestId = lost.sent[0]?.requestId ?? "";
  const off = update(lost.model, Message.ChangedConnectivity({ isOnline: false })).model;

  expect(streamShown(off)).toBe("offline");
  expect(whoShown(off)).toEqual(["you · not confirmed"]);

  const back = update(off, Message.ChangedConnectivity({ isOnline: true }));
  const sent = await settled(back, accepted);

  expect(streamShown(back.model)).toBe("live");
  expect(sent.sent.map((request) => request.requestId)).toEqual([requestId]);
  expect(whoShown(sent.model)).toEqual(["you · queued"]);
});

test("the note about an unconfirmed message is shown while a run is going", async () => {
  const lost = await settled(sentFromPrompt("do it", running()), offline);

  expect(runShown(lost.model)).toMatch(/^running · not confirmed/u);
});
