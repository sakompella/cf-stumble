import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { expect, test } from "vitest";
import { checkedWording, generationReading, gitHubReport } from "../../../src/page/client/api.js";
import { Message } from "../../../src/page/client/message.js";
import { ControlRequest, type Model } from "../../../src/page/client/model.js";
import { controlLabel } from "../../../src/page/client/update-generation.js";
import { init, update } from "../../../src/page/client/update.js";
import { entryItem, received, running, viewing, whoShown, type Conversation } from "./views.js";

const PROJECTS = [
  { id: "repo", displayName: "hello-world", isHarness: false, location: "https://github.com/o/r" },
  { id: "harness", displayName: "harness", isHarness: true, location: "/workspace/harness" },
];

const MINTED = { projectId: "repo", requestId: "r1", content: "do it" };

type Step = Message | ((model: Model) => Message);

function after(start: Model, steps: readonly Step[]): Model {
  return steps.reduce(
    (model, step) => update(model, Predicate.isFunction(step) ? step(model) : step).model,
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

test("the first listed project is selected and its events stream opened", () => {
  const listed = update(init().model, Message.SucceededFetchProjects({ projects: PROJECTS }));

  expect(listed.model.projectListStatus).toBe("1 connected");
  expect(listed.model.conversationState).toBe("reading");
  expect(Option.getOrNull(listed.model.maybeProjectId)).toBe("repo");
  expect(listed.model.eventsStreamId).toBe(init().model.eventsStreamId + 1);
  expect(listed.commands ?? []).toEqual([]);
});

test("asking to refresh GitHub is what checks the connection again", () => {
  expect(commandNames(readyPage(), Message.ClickedRefreshGitHub())).toEqual(["RefreshGitHub"]);
});

const CONNECTED_GITHUB = { state: "connected", login: "octocat", source: "device-authorization" };

const LATE_MORNING = new Date(2026, 9, 16, 11, 5).getTime();

test("the page words when the Worker last checked GitHub, with the date once it is not today", () => {
  const now = new Date(2026, 9, 16, 15, 0).getTime();

  expect(checkedWording(LATE_MORNING, now)).toBe("11:05");
  expect(checkedWording(new Date(2026, 9, 15, 23, 59).getTime(), now)).toBe("2026-10-15 23:59");
  expect(checkedWording(null, now)).toBe("");
});

test("a pending authorization is the Worker's live state, so it carries no check time", () => {
  const awaiting = { state: "awaiting-authorization", userCode: "WDJB-MJHT", verificationUri: "u" };

  expect(gitHubReport(awaiting, LATE_MORNING, LATE_MORNING)).toMatchObject({
    connection: { checked: "" },
  });
});

test("the last-known check time stays with its state until a request replaces the state", () => {
  const known = Message.SucceededGitHub({
    github: gitHubReport(CONNECTED_GITHUB, LATE_MORNING, LATE_MORNING),
  });

  const checked = after(readyPage(), [known]);

  expect(checked.github).toMatchObject({ state: "connected", checked: "11:05" });
  expect(after(checked, [Message.ClickedRefreshGitHub()]).github.checked).toBe("11:05");
  expect(after(checked, [Message.FailedGitHub({ detail: "offline" })]).github.checked).toBe("");
  expect(after(checked, [Message.RejectedGitHub({ wording: "error: 503" })]).github.checked).toBe(
    "",
  );
});

test("sending trims the prompt, clears it, and posts it under a minted request id", () => {
  const clicked = update(
    after(readyPage(), [Message.UpdatedPrompt({ value: "  do it  " })]),
    Message.ClickedSendTurn(),
  );

  expect(clicked.model.prompt).toBe("");
  expect(clicked.commands?.[0]?.name).toBe("MintRequestId");
  expect(clicked.commands?.[0]?.args).toEqual({ projectId: "repo", content: "do it" });

  const minted = update(clicked.model, Message.MintedRequestId(MINTED));

  expect(minted.commands?.[0]?.name).toBe("SendMessage");
  expect(minted.commands?.[0]?.args).toEqual(MINTED);
  expect(minted.model.outbox).toEqual([
    { requestId: "r1", text: "do it", maybeSubmissionId: Option.none(), afterEntry: 0 },
  ]);
});

test("a message sent while a run is active is accepted, shown as queued, then placed", () => {
  const busy = after(readyPage(), [conversation(running())]);
  const sent = sentPage(busy);

  expect(sent.commands?.[0]?.name).toBe("SendMessage");

  const queuedView = running({ inbox: [{ id: 5, text: "do it" }] });

  const queued = after(sent.model, [
    Message.SucceededSend({ requestId: "r1", submissionId: 5 }),
    conversation(queuedView),
  ]);

  expect(queued.outbox.map((item) => item.maybeSubmissionId)).toEqual([Option.some(5)]);
  expect(whoShown(queued)).toEqual(["you · queued"]);

  const placed = after(queued, [
    conversation(running({ items: [entryItem(7, { role: "user", content: "do it" })] })),
  ]);

  expect(placed.outbox).toEqual([]);
  expect(whoShown(placed)).toEqual(["you"]);
});

test("a reconnect keeps only the sent messages its view still holds queued", () => {
  const page = after(readyPage(), [
    Message.MintedRequestId({ ...MINTED, requestId: "placed" }),
    Message.MintedRequestId({ ...MINTED, requestId: "queued" }),
    Message.MintedRequestId({ ...MINTED, requestId: "sending" }),
    Message.SucceededSend({ requestId: "placed", submissionId: 1 }),
    Message.SucceededSend({ requestId: "queued", submissionId: 2 }),
    conversation(viewing({ inbox: [{ id: 2, text: "do it" }] })),
  ]);

  expect(page.outbox.map((item) => item.requestId)).toEqual(["queued", "sending"]);
  expect(page.conversationState).toBe("live");
});

test("a refused send takes the message out of the transcript, says why, and puts the text back in the prompt", () => {
  const refused = after(sentPage(readyPage()).model, [
    Message.RejectedSend({ requestId: "r1", wording: "busy: the workspace is resetting" }),
  ]);

  expect(refused.outbox).toEqual([]);
  expect(refused.runNote).toBe("busy: the workspace is resetting");
  expect(refused.prompt).toBe("do it");
});

test("a send that never reached the Worker puts the text back too", () => {
  const failed = after(sentPage(readyPage()).model, [
    Message.FailedSend({ requestId: "r1", detail: "offline" }),
  ]);

  expect(failed.prompt).toBe("do it");
});

test("a failed send puts its text before what the owner typed since, after a blank line", () => {
  const failed = after(sentPage(readyPage()).model, [
    Message.UpdatedPrompt({ value: "newer" }),
    Message.FailedSend({ requestId: "r1", detail: "offline" }),
  ]);

  expect(failed.prompt).toBe("do it\n\nnewer");
  expect(failed.outbox).toEqual([]);
});

test("two refused sends both keep their text in the prompt", () => {
  const refused = after(sentPage(readyPage()).model, [
    Message.MintedRequestId({ ...MINTED, requestId: "r2", content: "then this" }),
    Message.RejectedSend({ requestId: "r1", wording: "busy: send again once it finishes" }),
    Message.RejectedSend({ requestId: "r2", wording: "busy: send again once it finishes" }),
  ]);

  expect(refused.prompt).toBe("then this\n\ndo it");
  expect(refused.outbox).toEqual([]);
});

const noteAfterRun = (ending: Conversation) => {
  const busy = after(readyPage(), [conversation(running())]);

  return after(busy, [conversation(ending)]).runNote;
};

test("a run's end says how it ended", () => {
  expect(noteAfterRun(viewing())).toBe("answered");
  expect(noteAfterRun(viewing({ maybeRunFailure: Option.some("aborted") }))).toBe(
    "stopped: aborted",
  );
  expect(after(readyPage(), [conversation(viewing())]).runNote).toBe("");
});

test("cancelling posts an abort for the selected project", () => {
  const cancelled = update(readyPage(), Message.ClickedCancelTurn());

  expect(cancelled.commands?.[0]?.name).toBe("AbortRun");
  expect(cancelled.commands?.[0]?.args).toEqual({ projectId: "repo" });
});

test("a dropped stream says it is reconnecting and keeps the conversation it showed", () => {
  const busy = after(readyPage(), [conversation(running())]);

  const dropped = after(busy, [
    Message.DisconnectedEvents({ streamId: busy.eventsStreamId, detail: "the stream ended" }),
  ]);

  expect(dropped.conversationState).toBe("reconnecting: the stream ended");
  expect(dropped.conversation).toEqual(busy.conversation);
});

test("a fresh thread needs two clicks and no active run, then opens a new stream", () => {
  const armed = after(readyPage(), [Message.ClickedFreshThread()]);

  expect(armed.isFreshArmed).toBe(true);
  expect(commandNames(armed, Message.ClickedFreshThread())).toEqual(["ReplaceThread"]);

  const busy = after(armed, [conversation(running())]);

  expect(commandNames(busy, Message.ClickedFreshThread())).toEqual([]);
  expect(update(busy, Message.ClickedFreshThread()).model.freshThreadStatus).toBe(
    "a run is active; cancel it first",
  );

  const fresh = after(armed, [
    conversation(viewing({ items: [entryItem(3, { role: "user", content: "hi" })] })),
    Message.SucceededFreshThread({ streamId: armed.eventsStreamId }),
  ]);

  expect(fresh.eventsStreamId).toBe(armed.eventsStreamId + 1);
  expect(fresh.conversation.items).toEqual([]);
  expect(fresh.freshThreadStatus).toBe("fresh thread started; repository files are untouched");
});

test("activation sends nothing until the page has rendered an epoch", () => {
  const page = after(readyPage(), [
    Message.UpdatedControlLabelInput({ kind: "activate", value: "2" }),
  ]);

  expect(commandNames(page, Message.ClickedControl({ kind: "activate" }))).toEqual([]);

  const shown = after(page, [
    Message.SucceededFetchStatus({
      reading: {
        maybeActive: Option.some({ label: 1, harnessCommit: "abc", status: "ready" }),
        epoch: 3,
      },
    }),
  ]);

  const sent = update(shown, Message.ClickedControl({ kind: "activate" }));

  expect(sent.model.activate.request).toEqual(ControlRequest.Running({ sentEpoch: 3 }));
  expect(sent.commands?.[0]?.args).toEqual({ kind: "activate", observedEpoch: 3, label: 2 });
});

test("a generation label names one whole generation or nothing", () => {
  expect(Option.getOrNull(controlLabel("2"))).toBe(2);
  expect(Option.getOrNull(controlLabel(" 3 "))).toBe(3);
  expect(Option.getOrNull(controlLabel("0"))).toBe(0);
  expect(Option.getOrNull(controlLabel("1.5"))).toBe(null);
  expect(Option.getOrNull(controlLabel("-1"))).toBe(null);
  expect(Option.getOrNull(controlLabel(""))).toBe(null);
  expect(Option.getOrNull(controlLabel("two"))).toBe(null);
});

test("the status answer is read into a numeric label and epoch, or refused", () => {
  const generation = { label: 2, harnessCommit: "abc", status: "ready" };

  expect(
    Option.getOrNull(generationReading({ activeGeneration: { generation, epoch: 4 } })),
  ).toEqual({ maybeActive: Option.some(generation), epoch: 4 });

  expect(
    Option.getOrNull(generationReading({ activeGeneration: { generation: null, epoch: 0 } })),
  ).toEqual({ maybeActive: Option.none(), epoch: 0 });

  expect(
    Option.isNone(generationReading({ ok: false, problem: { code: "status-unavailable" } })),
  ).toBe(true);
  expect(Option.isNone(generationReading({ activeGeneration: { generation, epoch: "4" } }))).toBe(
    true,
  );
});
