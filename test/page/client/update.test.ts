/**
 * The owner page's behaviour as its update function sees it: Messages in, Model and Commands out.
 * No DOM runs here; the browser harness checks the rendered page.
 */

import * as Option from "effect/Option";
import { expect, test } from "vitest";
import { checkedWording, freshRefusalText, gitHubReport } from "../../../src/page/client/api.js";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import type { TurnFrame } from "../../../src/page/client/frames.js";
import { controlLabel } from "../../../src/page/client/update-generation.js";
import { init, update } from "../../../src/page/client/update.js";

const PROJECTS = [
  { id: "repo", displayName: "hello-world", isHarness: false, location: "https://github.com/o/r" },
  { id: "harness", displayName: "harness", isHarness: true, location: "/workspace/harness" },
];

const THREAD = { revision: "3", turnActive: "no", messageCount: "0", conversation: "[]" };

function after(start: Model, messages: readonly Message[]): Model {
  return messages.reduce((model, message) => update(model, message).model, start);
}

function commandNames(model: Model, message: Message): readonly string[] {
  return (update(model, message).commands ?? []).map((command) => command.name);
}

/** A page that listed both projects, selected the first, and read its empty thread. */
function readyPage(): Model {
  return after(init().model, [
    Message.SucceededFetchProjects({ projects: PROJECTS }),
    Message.SucceededFetchThread({ selection: 1, isQuiet: false, thread: THREAD }),
  ]);
}

function streaming(model: Model): Model {
  return after(model, [Message.UpdatedPrompt({ value: "  do it  " }), Message.ClickedSendTurn()]);
}

test("the first listed project is selected and its thread read", () => {
  const listed = update(init().model, Message.SucceededFetchProjects({ projects: PROJECTS }));

  expect(listed.model.projectListStatus).toBe("1 connected");
  expect(listed.model.conversationState).toBe("reading");
  expect(Option.getOrNull(listed.model.maybeProjectId)).toBe("repo");
  expect((listed.commands ?? []).map((command) => command.name)).toEqual(["FetchThread"]);
});

test("the page checks the GitHub connection on load and again only when the owner asks", () => {
  expect((init().commands ?? []).map((command) => command.name)).toEqual([
    "FetchStatus",
    "FetchProjects",
    "RefreshGitHub",
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

test("sending a turn trims the prompt, shows it, and starts the stream", () => {
  const sent = streaming(readyPage());

  expect(sent.turn).toMatchObject({ _tag: "Streaming", projectId: "repo", prompt: "do it" });
  expect(sent.prompt).toBe("");
  expect(sent.turnState).toBe("running");
  expect(sent.transcript.at(-1)).toMatchObject({ _tag: "Text", role: "user", text: "do it" });
});

const FRAMES: readonly (readonly [TurnFrame, string])[] = [
  [{ kind: "saved", revision: 4, messageCount: 2 }, "saved · revision 4 · 2 messages"],
  [
    { kind: "turn-failed", code: "model-error", saved: true, revision: 4 },
    "failed: model-error · saved at revision 4",
  ],
  [{ kind: "turn-failed", code: "model-error", saved: false }, "failed: model-error · not saved"],
  [{ kind: "turn-rejected", code: "invalid-turn-request" }, "rejected: invalid-turn-request"],
  [{ kind: "save-failed", code: "stale-revision" }, "not saved: stale-revision"],
  [{ kind: "stream-invalid", code: "malformed-frame" }, "unreadable turn stream: malformed-frame"],
  [{ kind: "cancelled" }, "cancelled"],
  [{ kind: "timed-out" }, "timed out"],
];

test("every terminal frame states its own ending, and only saved is not a problem", () => {
  for (const [frame, wording] of FRAMES) {
    const model = streaming(readyPage());
    const turnId = model.turnCount;
    const ended = after(model, [Message.ReceivedTurnFrame({ turnId, frame })]);

    expect(ended.turnState).toBe(wording);
    expect(ended.transcript.at(-1)).toMatchObject({
      _tag: "Terminal",
      wording,
      isProblem: frame.kind !== "saved",
    });
  }
});

test("streamed text joins one assistant block until a tool interrupts it", () => {
  const model = streaming(readyPage());
  const turnId = model.turnCount;
  const frame = (value: TurnFrame) => Message.ReceivedTurnFrame({ turnId, frame: value });

  const streamed = after(model, [
    frame({ kind: "text", text: "Hel" }),
    frame({ kind: "text", text: "lo" }),
    frame({ kind: "tool-start", toolCallId: "t1", toolName: "read", arguments: { path: "a" } }),
    frame({
      kind: "tool-result",
      toolCallId: "t1",
      toolName: "read",
      isError: true,
      content: "no such file",
      truncated: false,
    }),
    frame({ kind: "text", text: "again" }),
  ]);

  const kinds = streamed.transcript.map((entry) => entry._tag);

  expect(kinds).toEqual(["Text", "Text", "Tool", "Text"]);
  expect(streamed.transcript[1]).toMatchObject({ role: "assistant", text: "Hello" });
  expect(streamed.transcript[2]).toMatchObject({ summary: "read — failed", isFailed: true });
});

test("a frame for a turn the page no longer holds is dropped", () => {
  const model = streaming(readyPage());
  const turnId = model.turnCount;
  const switched = after(model, [Message.ClickedProject({ projectId: "harness" })]);

  const late = after(switched, [
    Message.ReceivedTurnFrame({ turnId, frame: { kind: "text", text: "EXTERNAL-LATE" } }),
    Message.EndedTurnStream({ turnId }),
  ]);

  expect(switched.turn._tag).toBe("Idle");
  expect(late).toEqual(switched);
});

test("a thread read for a project the reader left is dropped", () => {
  const switched = after(readyPage(), [Message.ClickedProject({ projectId: "harness" })]);

  const stale = Message.SucceededFetchThread({
    selection: switched.selection - 1,
    isQuiet: false,
    thread: { ...THREAD, revision: "99" },
  });

  expect(update(switched, stale).model).toEqual(switched);
});

test("a project whose thread read is refused shows none of the previous project's thread facts", () => {
  const first = after(readyPage(), [
    Message.SucceededFetchThread({
      selection: 1,
      isQuiet: false,
      thread: { ...THREAD, revision: "7", turnActive: "yes", messageCount: "4" },
    }),
  ]);

  const refused = after(first, [
    Message.ClickedProject({ projectId: "harness" }),
    Message.RejectedFetchThread({ selection: first.selection + 1, wording: "rejected: busy" }),
  ]);

  expect(refused.conversationState).toBe("rejected: busy");
  expect(refused).toMatchObject({
    threadRevision: "",
    threadTurnActive: "",
    threadMessageCount: "",
  });
});

test("cancelling ends the turn here and re-reads the thread", () => {
  const model = streaming(readyPage());
  const cancelled = update(model, Message.ClickedCancelTurn());

  expect(cancelled.model.turn._tag).toBe("Idle");
  expect(cancelled.model.turnState).toBe("cancelled: this browser stopped the turn");
  expect(commandNames(model, Message.ClickedCancelTurn())).toEqual(["FetchThread"]);
});

test("a stream that ends without a terminal frame says so", () => {
  const model = streaming(readyPage());
  const ended = after(model, [Message.EndedTurnStream({ turnId: model.turnCount })]);

  expect(ended.turnState).toBe("the turn stream ended without a terminal frame");
});

test("a fresh thread needs two clicks and no running turn", () => {
  const page = readyPage();

  expect(commandNames(page, Message.ClickedFreshThread())).toEqual([]);

  const armed = after(page, [Message.ClickedFreshThread()]);

  expect(commandNames(armed, Message.ClickedFreshThread())).toEqual(["ReplaceThread"]);
  expect(after(streaming(page), [Message.ClickedFreshThread()]).freshThreadStatus).toBe(
    "a turn is running; cancel it first",
  );
});

test("a fresh thread refused for a turn running elsewhere says so and leaves the conversation", () => {
  const page = readyPage();

  const wording = freshRefusalText({
    status: 409,
    payload: { ok: false, problem: { code: "turn-active" } },
  });

  const refused = after(page, [
    Message.RejectedFreshThread({ selection: page.selection, wording }),
  ]);

  expect(refused.freshThreadStatus).toBe(
    "not started: a turn is running on this project; start a fresh thread once it ends",
  );
  expect(refused.conversationState).toBe(page.conversationState);
});

test("activation sends nothing until the page has rendered an epoch", () => {
  const page = after(readyPage(), [
    Message.UpdatedControlLabelInput({ kind: "activate", value: "2" }),
  ]);

  expect(commandNames(page, Message.ClickedControl({ kind: "activate" }))).toEqual([]);

  const shown = after(page, [
    Message.SucceededFetchStatus({ label: "1", commit: "abc", status: "ready", epoch: "3" }),
  ]);

  const sent = update(shown, Message.ClickedControl({ kind: "activate" }));

  expect(sent.model.activate.sentEpoch).toBe("3");
  expect(sent.commands?.[0]?.args).toEqual({ kind: "activate", observedEpoch: 3, label: 2 });
});

test("a generation label names one whole generation or nothing", () => {
  // Number.parseInt("1.5") is 1, so a page that parsed the field would activate generation 1 for a
  // reader who typed something that names no generation at all.
  expect(Option.getOrNull(controlLabel("2"))).toBe(2);
  expect(Option.getOrNull(controlLabel(" 3 "))).toBe(3);
  expect(Option.getOrNull(controlLabel("0"))).toBe(0);
  expect(Option.getOrNull(controlLabel("1.5"))).toBe(null);
  expect(Option.getOrNull(controlLabel("-1"))).toBe(null);
  expect(Option.getOrNull(controlLabel(""))).toBe(null);
  expect(Option.getOrNull(controlLabel("two"))).toBe(null);
});
