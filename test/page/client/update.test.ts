import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { expect, test } from "vitest";
import { checkedWording, generationReading, gitHubReport } from "../../../src/page/client/api.js";
import type { AgentEvent } from "../../../src/page/client/agent-event.js";
import { Message } from "../../../src/page/client/message.js";
import { ControlRequest, type Model } from "../../../src/page/client/model.js";
import { controlLabel } from "../../../src/page/client/update-generation.js";
import { init, update } from "../../../src/page/client/update.js";

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

  return after(listed, [
    Message.ReceivedEvent({
      streamId: listed.eventsStreamId,
      event: { type: "snapshot", entries: [], tools: [], inbox: [] },
    }),
  ]);
}

function event(value: AgentEvent): (model: Model) => Message {
  return (model) => Message.ReceivedEvent({ streamId: model.eventsStreamId, event: value });
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

test("the page reads the recorded GitHub connection on load and checks it again only when the owner asks", () => {
  expect((init().commands ?? []).map((command) => command.name)).toEqual([
    "FetchStatus",
    "FetchProjects",
    "FetchGitHub",
    "FetchChatGPT",
  ]);
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
    { requestId: "r1", text: "do it", maybeSubmissionId: Option.none() },
  ]);
});

test("a message sent while a run is active is accepted, shown as queued, then placed", () => {
  const running = after(readyPage(), [event({ type: "run_start", inputs: [1] })]);
  const sent = sentPage(running);

  expect(sent.commands?.[0]?.name).toBe("SendMessage");

  const queued = after(sent.model, [
    Message.SucceededSend({ requestId: "r1", submissionId: 5 }),
    event({ type: "submission", record: { id: 5, requestId: "r1", status: "queued" } }),
    event({ type: "inbox_update", items: [{ id: 5 }] }),
  ]);

  expect(queued.outbox.map((item) => item.maybeSubmissionId)).toEqual([Option.some(5)]);

  const placed = after(queued, [
    event({ type: "submission", record: { id: 5, requestId: "r1", status: "placed" } }),
  ]);

  expect(placed.outbox).toEqual([]);
});

test("a reconnect keeps only the sent messages its snapshot still holds queued", () => {
  const page = after(readyPage(), [
    Message.MintedRequestId({ ...MINTED, requestId: "placed" }),
    Message.MintedRequestId({ ...MINTED, requestId: "queued" }),
    Message.MintedRequestId({ ...MINTED, requestId: "sending" }),
    Message.SucceededSend({ requestId: "placed", submissionId: 1 }),
    Message.SucceededSend({ requestId: "queued", submissionId: 2 }),
    event({ type: "snapshot", entries: [], tools: [], inbox: [{ id: 2 }] }),
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

test("a send that never reached the Worker puts the text back too, unless the owner already typed something else", () => {
  const sent = sentPage(readyPage()).model;
  const failed = Message.FailedSend({ requestId: "r1", detail: "offline" });

  expect(after(sent, [failed]).prompt).toBe("do it");
  expect(after(sent, [Message.UpdatedPrompt({ value: "newer" }), failed]).prompt).toBe("newer");
});

const noteAfter = (record: Readonly<{ id: number; status: string; reason?: string }>) =>
  after(readyPage(), [event({ type: "submission", record })]).runNote;

test("a settled submission says how the run ended", () => {
  expect(noteAfter({ id: 1, status: "done" })).toBe("answered");
  expect(noteAfter({ id: 1, status: "unanswered", reason: "aborted" })).toBe("stopped: aborted");
  expect(noteAfter({ id: 1, status: "placed" })).toBe("");
});

test("cancelling posts an abort for the selected project", () => {
  const cancelled = update(readyPage(), Message.ClickedCancelTurn());

  expect(cancelled.commands?.[0]?.name).toBe("AbortRun");
  expect(cancelled.commands?.[0]?.args).toEqual({ projectId: "repo" });
});

test("an event or refusal from a stream the page replaced is dropped", () => {
  const page = readyPage();
  const switched = after(page, [Message.ClickedProject({ projectId: "harness" })]);
  const old = page.eventsStreamId;

  expect(switched.eventsStreamId).not.toBe(old);
  expect(
    after(switched, [
      Message.ReceivedEvent({ streamId: old, event: { type: "run_start", inputs: [1] } }),
      Message.RefusedEvents({ streamId: old, wording: "rejected: x" }),
    ]),
  ).toEqual(switched);
});

test("a dropped stream says it is reconnecting and keeps the conversation it showed", () => {
  const running = after(readyPage(), [event({ type: "run_start", inputs: [1] })]);

  const dropped = after(running, [
    Message.DisconnectedEvents({ streamId: running.eventsStreamId, detail: "the stream ended" }),
  ]);

  expect(dropped.conversationState).toBe("reconnecting: the stream ended");
  expect(dropped.conversation).toEqual(running.conversation);
});

test("a fresh thread needs two clicks and no active run, then opens a new stream", () => {
  const armed = after(readyPage(), [Message.ClickedFreshThread()]);

  expect(armed.isFreshArmed).toBe(true);
  expect(commandNames(armed, Message.ClickedFreshThread())).toEqual(["ReplaceThread"]);

  const running = after(armed, [event({ type: "run_start", inputs: [1] })]);

  expect(commandNames(running, Message.ClickedFreshThread())).toEqual([]);
  expect(update(running, Message.ClickedFreshThread()).model.freshThreadStatus).toBe(
    "a run is active; cancel it first",
  );

  const fresh = after(armed, [
    event({ type: "message_end", entry: { id: 3, kind: "pi.user" } }),
    Message.SucceededFreshThread({ streamId: armed.eventsStreamId }),
  ]);

  expect(fresh.eventsStreamId).toBe(armed.eventsStreamId + 1);
  expect(fresh.conversation.entries).toEqual([]);
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
