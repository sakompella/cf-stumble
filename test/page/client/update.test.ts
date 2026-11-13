import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { expect, test } from "vitest";
import {
  checkedWording,
  decodeStatusAnswer,
  generationReading,
  gitHubReport,
  submitRejection,
} from "../../../src/page/client/api.js";
import { Message } from "../../../src/page/client/message.js";
import { ControlRequest, type Model } from "../../../src/page/client/model.js";
import { controlLabel } from "../../../src/page/client/update-generation.js";
import { init, update } from "../../../src/page/client/update.js";
import { freshShown, streamShown, whoShown } from "./shown.js";
import { entryItem, received, running, viewing, type Conversation } from "./views.js";

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
  expect(streamShown(listed.model)).toBe("reading");
  expect(Option.getOrNull(listed.model.maybeProjectId)).toBe("repo");
  expect(listed.model.eventsStreamId).toBe(init().model.eventsStreamId + 1);
  expect(listed.commands ?? []).toEqual([]);
});

test("asking to refresh GitHub is what checks the connection again", () => {
  expect(commandNames(readyPage(), Message.ClickedRefreshGitHub())).toEqual(["RefreshGitHub"]);
});

const CONNECTED_GITHUB = {
  state: "connected",
  login: "octocat",
  source: "device-authorization",
} as const;

const LATE_MORNING = new Date(2026, 9, 16, 11, 5).getTime();

test("the page words when the Worker last checked GitHub, with the date once it is not today", () => {
  const now = new Date(2026, 9, 16, 15, 0).getTime();

  expect(checkedWording(LATE_MORNING, now)).toBe("11:05");
  expect(checkedWording(new Date(2026, 9, 15, 23, 59).getTime(), now)).toBe("2026-10-15 23:59");
  expect(checkedWording(null, now)).toBe("");
});

test("a pending authorization is the Worker's live state, so it carries no check time", () => {
  const awaiting = {
    state: "awaiting-authorization",
    userCode: "WDJB-MJHT",
    verificationUri: "u",
    expiresAt: 1,
  } as const;

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
  expect(minted.commands?.[0]?.args).toEqual({ ...MINTED, budgetMinutes: 30 });
  expect(whoShown(minted.model)).toEqual(["you · sending"]);
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

  expect(whoShown(queued)).toEqual(["you · queued"]);

  const placed = after(queued, [
    conversation(running({ items: [entryItem(7, { role: "user", content: "do it" })] })),
  ]);

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

  expect(page.outgoing.map((item) => item.requestId)).toEqual(["queued", "sending"]);
  expect(streamShown(page)).toBe("live");
});

test("a refused send takes the message out of the transcript, says why, and puts the text back in the prompt", () => {
  const refused = after(sentPage(readyPage()).model, [
    Message.RejectedSend({ requestId: "r1", wording: "busy: the workspace is resetting" }),
  ]);

  expect(refused.outgoing).toEqual([]);
  expect(refused.runNote).toBe("busy: the workspace is resetting");
  expect(refused.prompt).toBe("do it");
});

test("a refused send puts its text before what the owner typed since, after a blank line", () => {
  const refused = after(sentPage(readyPage()).model, [
    Message.UpdatedPrompt({ value: "newer" }),
    Message.RejectedSend({ requestId: "r1", wording: "busy" }),
  ]);

  expect(refused.prompt).toBe("do it\n\nnewer");
  expect(refused.outgoing).toEqual([]);
});

test("two refused sends both keep their text in the prompt", () => {
  const refused = after(sentPage(readyPage()).model, [
    Message.MintedRequestId({ ...MINTED, requestId: "r2", content: "then this" }),
    Message.RejectedSend({ requestId: "r1", wording: "busy: send again once it finishes" }),
    Message.RejectedSend({ requestId: "r2", wording: "busy: send again once it finishes" }),
  ]);

  expect(refused.prompt).toBe("then this\n\ndo it");
  expect(refused.outgoing).toEqual([]);
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

test("a failure the page never saw the run for is still shown, once", () => {
  const failed = viewing({ maybeRunFailure: Option.some("no_model") });

  const first = update(init().model, received(init().model, failed)).model;

  expect(first.runNote).toBe("stopped: no_model");

  const idle = after(readyPage(), [conversation(failed)]);

  expect(idle.runNote).toBe("stopped: no_model");
  expect(after(idle, [conversation(failed)]).runNote).toBe("stopped: no_model");
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

  expect(streamShown(dropped)).toBe("reconnecting: the stream ended");
  expect(dropped.conversation).toEqual(busy.conversation);
});

test("a fresh thread needs two clicks and no active run, then opens a new stream", () => {
  const armed = after(readyPage(), [Message.ClickedFreshThread()]);

  expect(commandNames(armed, Message.ClickedFreshThread())).toEqual(["ReplaceThread"]);

  const busy = after(armed, [conversation(running())]);

  expect(commandNames(busy, Message.ClickedFreshThread())).toEqual([]);
  expect(freshShown(update(busy, Message.ClickedFreshThread()).model)).toBe(
    "a run is active; cancel it first",
  );

  const fresh = after(armed, [
    conversation(viewing({ items: [entryItem(3, { role: "user", content: "hi" })] })),
    Message.SucceededFreshThread({ streamId: armed.eventsStreamId }),
  ]);

  expect(fresh.eventsStreamId).toBe(armed.eventsStreamId + 1);
  expect(fresh.conversation.items).toEqual([]);
  expect(freshShown(fresh)).toBe("fresh thread started; repository files are untouched");
});

test("clicks while a fresh thread is starting send no second replace", () => {
  const starting = after(readyPage(), [Message.ClickedFreshThread(), Message.ClickedFreshThread()]);

  const later = [1, 2, 3].flatMap(() =>
    commandNames(after(starting, [Message.ClickedFreshThread()]), Message.ClickedFreshThread()),
  );

  expect(later).toEqual([]);
  expect(commandNames(starting, Message.ClickedFreshThread())).toEqual([]);
});

test("sending a message while a fresh thread is starting keeps the page saying so", () => {
  const starting = after(readyPage(), [Message.ClickedFreshThread(), Message.ClickedFreshThread()]);

  const sent = after(starting, [
    Message.UpdatedPrompt({ value: "hi" }),
    Message.ClickedSendTurn(),
    Message.ClickedFreshThread(),
  ]);

  expect(freshShown(sent)).toBe("starting a fresh thread");
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
        maybeMainAhead: Option.none(),
      },
    }),
  ]);

  const sent = update(shown, Message.ClickedControl({ kind: "activate" }));

  expect(sent.model.activate.request).toEqual(ControlRequest.Running({ sentEpoch: 3 }));
  expect(sent.commands?.[0]?.args).toEqual({ kind: "activate", observedEpoch: 3, label: 2 });
});

test("a second click while an activation or a submission is running sends nothing", () => {
  const page = after(readyPage(), [
    Message.UpdatedControlLabelInput({ kind: "activate", value: "2" }),
    Message.UpdatedCandidateCommitInput({ value: "abc" }),
    Message.SucceededFetchStatus({
      reading: { maybeActive: Option.none(), epoch: 3, maybeMainAhead: Option.none() },
    }),
    Message.ClickedControl({ kind: "activate" }),
    Message.ClickedSubmitCandidate(),
  ]);

  expect(commandNames(page, Message.ClickedControl({ kind: "activate" }))).toEqual([]);
  expect(commandNames(page, Message.ClickedSubmitCandidate())).toEqual([]);
});

test("a generation label names one whole generation or nothing", () => {
  expect(Option.getOrNull(controlLabel("2"))).toBe(2);
  expect(Option.getOrNull(controlLabel(" 3 "))).toBe(3);
  expect(Option.getOrNull(controlLabel("0"))).toBe(0);
  expect(Option.getOrNull(controlLabel("1.5"))).toBe(null);
  expect(Option.getOrNull(controlLabel("-1"))).toBe(null);
  expect(Option.getOrNull(controlLabel(""))).toBe(null);
  expect(Option.getOrNull(controlLabel("two"))).toBe(null);
  expect(Option.getOrNull(controlLabel("1e3"))).toBe(null);
  expect(Option.getOrNull(controlLabel("0x10"))).toBe(null);
  expect(Option.getOrNull(controlLabel("+5"))).toBe(null);
  expect(Option.getOrNull(controlLabel("9007199254740993"))).toBe(null);
});

test("the status answer is read into a numeric label and epoch, or refused", () => {
  const generation = { label: 2, harnessCommit: "abc", status: "ready" };

  expect(generationReading({ activeGeneration: { generation, epoch: 4 }, mainAhead: 3 })).toEqual({
    maybeActive: Option.some(generation),
    epoch: 4,
    maybeMainAhead: Option.some(3),
  });

  expect(
    generationReading({ activeGeneration: { generation: null, epoch: 0 }, mainAhead: null }),
  ).toEqual({
    maybeActive: Option.none(),
    epoch: 0,
    maybeMainAhead: Option.none(),
  });

  expect(
    Option.isNone(decodeStatusAnswer({ ok: false, problem: { code: "status-unavailable" } })),
  ).toBe(true);
  expect(Option.isNone(decodeStatusAnswer({ activeGeneration: { generation, epoch: "4" } }))).toBe(
    true,
  );
});

test("a submit refused after the label was recorded says so", () => {
  expect(
    submitRejection({
      ok: false,
      error: { code: "preparation-failed" },
      recorded: { label: 7, harnessCommit: "abc" },
    }),
  ).toBe("label 7 recorded (commit abc), preparation failed: error: preparation-failed");
  expect(submitRejection({ ok: false, error: { code: "x" } })).toBe("error: x");
});
