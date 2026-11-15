import { expect, test } from "vitest";
import { checkedWording, gitHubReport } from "../../../src/page/client/api.js";
import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { init, update } from "../../../src/page/client/update.js";
import { settled } from "./requests.js";
import { shownText } from "./shown.js";

const CONNECTED_GITHUB = {
  state: "connected",
  login: "octocat",
  source: "device-authorization",
} as const;

const LATE_MORNING = new Date(2026, 9, 16, 11, 5).getTime();

const checkedShown = (model: Model): string => shownText(model, ID.githubChecked);

function after(start: Model, messages: readonly Message[]): Model {
  return messages.reduce((model, message) => update(model, message).model, start);
}

test("asking to refresh GitHub posts the refresh request and renders the Worker's answer", async () => {
  const done = await settled(update(init().model, Message.ClickedRefreshGitHub()), () =>
    Promise.resolve(Response.json({ ok: true, github: CONNECTED_GITHUB, checkedAt: LATE_MORNING })),
  );

  expect(done.sent).toEqual([{ method: "POST", path: "/api/github/connection/refresh", body: {} }]);
  expect(shownText(done.model, ID.githubDetail)).toBe("octocat (device-authorization)");
  expect(checkedShown(done.model)).not.toBe("");
});

test("the page words when the Worker last checked GitHub, with the date once it is not today", () => {
  const now = new Date(2026, 9, 16, 15, 0).getTime();

  expect(checkedWording(LATE_MORNING, now)).toBe("11:05");
  expect(checkedWording(new Date(2026, 9, 15, 23, 59).getTime(), now)).toBe("2026-10-15 23:59");
  expect(checkedWording(null, now)).toBe("");
});

test("a pending authorization is the Worker's live state, so it shows no check time", () => {
  const awaiting = {
    state: "awaiting-authorization",
    userCode: "WDJB-MJHT",
    verificationUri: "https://github.com/login/device",
    expiresAt: 1,
  } as const;

  const shown = after(init().model, [
    Message.SucceededGitHub({ github: gitHubReport(awaiting, LATE_MORNING, LATE_MORNING) }),
  ]);

  expect(shownText(shown, ID.githubDetail)).toBe("enter code WDJB-MJHT at GitHub");
  expect(shownText(shown, ID.githubVerificationLink)).toBe("https://github.com/login/device");
  expect(checkedShown(shown)).toBe("");
});

test("the last-known check time stays with its state until a request replaces the state", () => {
  const checked = after(init().model, [
    Message.SucceededGitHub({
      github: gitHubReport(CONNECTED_GITHUB, LATE_MORNING, LATE_MORNING),
    }),
  ]);

  expect(checkedShown(checked)).toBe("11:05");
  expect(checkedShown(after(checked, [Message.ClickedRefreshGitHub()]))).toBe("11:05");
  expect(checkedShown(after(checked, [Message.FailedGitHub({ detail: "offline" })]))).toBe("");
  expect(checkedShown(after(checked, [Message.RejectedGitHub({ wording: "error: 503" })]))).toBe(
    "",
  );
});
