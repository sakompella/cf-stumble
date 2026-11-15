import * as Option from "effect/Option";
import { expect, test } from "vitest";
import {
  decodeStatusAnswer,
  generationReading,
  submitRejection,
} from "../../../src/page/client/api.js";
import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { init, update } from "../../../src/page/client/update.js";
import { settled, type SentRequest } from "./requests.js";
import { shownText } from "./shown.js";

function after(start: Model, messages: readonly Message[]): Model {
  return messages.reduce((model, message) => update(model, message).model, start);
}

const STATUS_AT_EPOCH_3 = Message.SucceededFetchStatus({
  reading: {
    maybeActive: Option.some({ label: 1, harnessCommit: "abc", status: "ready" }),
    epoch: 3,
    maybeMainAhead: Option.none(),
  },
});

const activate = Message.ClickedControl({ kind: "activate" });

function labelled(value: string, messages: readonly Message[] = [STATUS_AT_EPOCH_3]): Model {
  return after(init().model, [
    Message.UpdatedControlLabelInput({ kind: "activate", value }),
    ...messages,
  ]);
}

const answered = (request: SentRequest) =>
  Promise.resolve(
    Response.json(
      request.path === "/api/generations/activate"
        ? { ok: true, outcome: { effect: "rolled forward" } }
        : { activeGeneration: { generation: null, epoch: 4 }, mainAhead: null },
    ),
  );

test("activation posts the typed label with the epoch the page has rendered, and only once it has one", async () => {
  const unread = update(labelled("2", []), activate);

  expect(unread.commands ?? []).toEqual([]);
  expect(shownText(unread.model, ID.activateStatus)).toBe("refresh the status first");

  const asked = update(labelled("2"), activate);

  expect(shownText(asked.model, ID.activateStatus)).toBe("running");
  expect(shownText(asked.model, ID.activateSentEpoch)).toBe("3");

  const done = await settled(asked, answered);

  expect(done.sent).toEqual([
    { method: "POST", path: "/api/generations/activate", body: { observedEpoch: 3, label: 2 } },
    { method: "GET", path: "/api/status", body: null },
  ]);
  expect(shownText(done.model, ID.activateStatus)).toBe("ok");
  expect(shownText(done.model, ID.activateSentEpoch)).toBe("3");
  expect(shownText(done.model, ID.activateEffect)).toBe("rolled forward");
});

test("regression 01c8f9f5: a label written as 1e3, 0x10 or +5 is refused, not read as 1000, 16 or 5", () => {
  for (const value of ["1e3", "0x10", "+5"]) {
    const clicked = update(labelled(value), activate);

    expect(clicked.commands ?? [], value).toEqual([]);
    expect(shownText(clicked.model, ID.activateStatus), value).toBe("enter a generation label");
  }
});

test("a second click while an activation or a submission is running sends nothing", () => {
  const page = labelled("2", [
    Message.UpdatedCandidateCommitInput({ value: "abc" }),
    STATUS_AT_EPOCH_3,
    activate,
    Message.ClickedSubmitCandidate(),
  ]);

  expect(update(page, activate).commands ?? []).toEqual([]);
  expect(update(page, Message.ClickedSubmitCandidate()).commands ?? []).toEqual([]);
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
