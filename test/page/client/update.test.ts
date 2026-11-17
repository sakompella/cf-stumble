import * as Option from "effect/Option";
import { expect, test } from "vitest";
import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import { subscriptions } from "../../../src/page/client/subscriptions.js";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { init, update } from "../../../src/page/client/update.js";
import { settled } from "./requests.js";
import {
  disabledShown,
  freshShown,
  promptShown,
  rowsShown,
  runShown,
  shownText,
  streamShown,
  whoShown,
} from "./shown.js";
import { entryItem, received, running, viewing, type Conversation } from "./views.js";

const PROJECTS = [
  { id: "repo", displayName: "hello-world", isHarness: false, location: "https://github.com/o/r" },
  { id: "harness", displayName: "harness", isHarness: true, location: "/workspace/harness" },
];

const MINTED = { projectId: "repo", requestId: "r1", content: "do it" };

type Step = Message | ((model: Model) => Message);

function after(start: Model, steps: readonly Step[]): Model {
  return steps.reduce(
    (model, step) => update(model, "_tag" in step ? step : step(model)).model,
    start,
  );
}

function commandNames(model: Model, message: Message): readonly string[] {
  return (update(model, message).commands ?? []).map((command) => command.name);
}

function readyPage(): Model {
  const listed = after(init().model, [Message.SucceededFetchProjects({ projects: PROJECTS })]);

  return after(listed, [received(listed, viewing())]);
}

function conversation(value: Conversation): (model: Model) => Message {
  return (model) => received(model, value);
}

function sentPage(model: Model) {
  return update(
    after(model, [Message.UpdatedPrompt({ value: "do it" }), Message.ClickedSendTurn()]),
    Message.MintedRequestId(MINTED),
  );
}

const userEntry = (id: number, content: string) => entryItem(id, { role: "user", content });

test("listing the projects selects the first one and starts reading its conversation", () => {
  const listed = update(init().model, Message.SucceededFetchProjects({ projects: PROJECTS }));
  const events = subscriptions["events"];

  expect(shownText(listed.model, ID.projectListStatus)).toBe("1 connected");
  expect(shownText(listed.model, ID.conversationProject)).toBe("hello-world");
  expect(streamShown(listed.model)).toBe("reading");
  expect(
    Option.map(
      events?.modelToDependencies(listed.model).maybeStream ?? Option.none(),
      (stream) => stream.projectId,
    ),
  ).toEqual(Option.some("repo"));
  expect(listed.commands ?? []).toEqual([]);
});

test("a message sent while a run is active is accepted, shown as queued, then placed", () => {
  const busy = after(readyPage(), [conversation(running())]);
  const sent = sentPage(busy);

  expect(sent.commands?.map((command) => command.name)).toEqual(["SendMessage"]);
  expect(whoShown(sent.model)).toEqual(["you · sending"]);

  const queued = after(sent.model, [
    Message.SucceededSend({ requestId: "r1", submissionId: 5 }),
    conversation(running({ inbox: [{ id: 5, text: "do it" }] })),
  ]);

  expect(whoShown(queued)).toEqual(["you · queued"]);
  expect(runShown(queued)).toBe("running · 1 queued");

  const placed = after(queued, [conversation(running({ items: [userEntry(7, "do it")] }))]);

  expect(rowsShown(placed)).toEqual([{ who: "you", text: "do it" }]);
});

test("a reconnect keeps only the sent messages its view still holds queued", () => {
  const page = after(readyPage(), [
    Message.MintedRequestId({ ...MINTED, requestId: "placed", content: "placed" }),
    Message.MintedRequestId({ ...MINTED, requestId: "queued", content: "queued" }),
    Message.MintedRequestId({ ...MINTED, requestId: "sending", content: "sending" }),
    Message.SucceededSend({ requestId: "placed", submissionId: 1 }),
    Message.SucceededSend({ requestId: "queued", submissionId: 2 }),
    conversation(viewing({ inbox: [{ id: 2, text: "queued" }] })),
  ]);

  expect(rowsShown(page)).toEqual([
    { who: "you · queued", text: "queued" },
    { who: "you · sending", text: "sending" },
  ]);
  expect(streamShown(page)).toBe("live");
});

test("a refused send takes the message out of the transcript, says why, and puts the text back in the prompt", () => {
  const refused = after(sentPage(readyPage()).model, [
    Message.RejectedSend({ requestId: "r1", wording: "busy: the workspace is resetting" }),
  ]);

  expect(rowsShown(refused)).toEqual([]);
  expect(runShown(refused)).toBe("busy: the workspace is resetting");
  expect(promptShown(refused)).toBe("do it");
});

test("each refused send goes back above what the prompt holds, after a blank line", () => {
  const refused = after(sentPage(readyPage()).model, [
    Message.MintedRequestId({ ...MINTED, requestId: "r2", content: "then this" }),
    Message.UpdatedPrompt({ value: "newer" }),
    Message.RejectedSend({ requestId: "r1", wording: "busy" }),
    Message.RejectedSend({ requestId: "r2", wording: "busy" }),
  ]);

  expect(promptShown(refused)).toBe("then this\n\ndo it\n\nnewer");
  expect(rowsShown(refused)).toEqual([]);
});

const shownAfterRun = (ending: Conversation) => {
  const busy = after(readyPage(), [conversation(running())]);

  return runShown(after(busy, [conversation(ending)]));
};

test("a run's end says how it ended", () => {
  expect(shownAfterRun(viewing())).toBe("answered");
  expect(shownAfterRun(viewing({ maybeRunFailure: Option.some("aborted") }))).toBe(
    "stopped: aborted",
  );
  expect(runShown(after(readyPage(), [conversation(viewing())]))).toBe("");
});

test("a failure the page never saw the run for is still shown", () => {
  const failed = viewing({ maybeRunFailure: Option.some("no_model") });

  expect(runShown(update(init().model, received(init().model, failed)).model)).toBe(
    "stopped: no_model",
  );
  expect(runShown(after(readyPage(), [conversation(failed)]))).toBe("stopped: no_model");
});

test("cancelling posts an abort for the selected project, and the page keeps saying so", async () => {
  const cancelled = update(readyPage(), Message.ClickedCancelTurn());

  expect(runShown(cancelled.model)).toBe("cancelling");

  const done = await settled(cancelled, () => Promise.resolve(Response.json({ ok: true })));

  expect(done.sent).toEqual([{ method: "POST", path: "/api/projects/repo/abort", body: null }]);
  expect(runShown(done.model)).toBe("cancelling");
});

test("a dropped stream says it is reconnecting and keeps the conversation it showed", () => {
  const busy = after(readyPage(), [conversation(running({ items: [userEntry(1, "hi")] }))]);

  const dropped = after(busy, [
    Message.DisconnectedEvents({ streamId: busy.eventsStreamId, detail: "the stream ended" }),
  ]);

  expect(streamShown(dropped)).toBe("reconnecting: the stream ended");
  expect(rowsShown(dropped)).toEqual([{ who: "you", text: "hi" }]);
});

test("a stream that ends after it was live reads the generation status again, and one that never was live does not", () => {
  const page = readyPage();
  const ended = Message.DisconnectedEvents({ streamId: page.eventsStreamId, detail: "x" });

  expect(commandNames(page, ended)).toEqual(["FetchStatus"]);

  const reconnecting = after(page, [ended]);

  expect(commandNames(reconnecting, ended)).toEqual([]);

  const opening = after(init().model, [Message.SucceededFetchProjects({ projects: PROJECTS })]);

  expect(commandNames(opening, Message.DisconnectedEvents({ streamId: 1, detail: "" }))).toEqual(
    [],
  );
});

test("a fresh thread needs two clicks and no active run, and starts the conversation over", () => {
  const armed = after(readyPage(), [Message.ClickedFreshThread()]);

  expect(freshShown(armed)).toBe(
    "click again to replace this conversation; repository files are untouched",
  );
  expect(commandNames(armed, Message.ClickedFreshThread())).toEqual(["ReplaceThread"]);

  const refused = update(after(armed, [conversation(running())]), Message.ClickedFreshThread());

  expect(refused.commands ?? []).toEqual([]);
  expect(freshShown(refused.model)).toBe("a run is active; cancel it first");

  const fresh = after(armed, [
    conversation(viewing({ items: [userEntry(3, "hi")] })),
    Message.ClickedFreshThread(),
    Message.SucceededFreshThread({ streamId: armed.eventsStreamId }),
  ]);

  expect(rowsShown(fresh)).toEqual([]);
  expect(freshShown(fresh)).toBe("fresh thread started; repository files are untouched");
});

test("while a fresh thread is starting its button is disabled and sending keeps the page saying so", () => {
  const starting = after(readyPage(), [Message.ClickedFreshThread(), Message.ClickedFreshThread()]);

  const sent = after(starting, [
    Message.UpdatedPrompt({ value: "hi" }),
    Message.ClickedSendTurn(),
    Message.ClickedFreshThread(),
  ]);

  expect(disabledShown(sent, ID.freshThreadButton)).toBe(true);
  expect(freshShown(sent)).toBe("starting a fresh thread");
});

test("a page showing a replaced conversation drops the old one's queued messages and note", () => {
  const old = after(readyPage(), [
    Message.MintedRequestId({ ...MINTED, requestId: "r", content: "hi" }),
    Message.SucceededSend({ requestId: "r", submissionId: 4 }),
    conversation(
      viewing({
        maybeId: Option.some(1),
        inbox: [{ id: 4, text: "hi" }],
        maybeRunFailure: Option.some("aborted"),
      }),
    ),
  ]);

  expect(whoShown(old)).toEqual(["you · queued"]);
  expect(runShown(old)).toBe("stopped: aborted");

  const replaced = after(old, [
    conversation(viewing({ maybeId: Option.some(2), inbox: [{ id: 4, text: "other" }] })),
  ]);

  expect(rowsShown(replaced)).toEqual([{ who: "you · queued", text: "other" }]);
  expect(runShown(replaced)).toBe("this conversation was replaced by a fresh thread");
});
