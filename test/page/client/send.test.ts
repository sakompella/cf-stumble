import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect, test, vi } from "vitest";
import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { init, update } from "../../../src/page/client/update.js";
import { openedTranscript } from "./transcript-resource.js";
import { promptShown, shownText, whoShown } from "./shown.js";
import { received, viewing } from "./views.js";

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

function sentFromPrompt(text: string): UpdateResult {
  const listed = update(init().model, Message.SucceededFetchProjects({ projects: PROJECTS })).model;
  const ready = update(listed, received(listed, viewing())).model;
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
