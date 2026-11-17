import { refusalText } from "../../../src/page/client/api.js";
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

test("a refused GitHub request leaves the stored state and puts the sentence in the detail, not 'asking GitHub'", () => {
  const connected = after(init().model, [
    Message.SucceededGitHub({ github: gitHubReport(CONNECTED_GITHUB, LATE_MORNING, LATE_MORNING) }),
    Message.ClickedAuthorize({ endpoint: "POST /api/github/authorization/complete" }),
  ]);

  expect(shownText(connected, ID.githubDetail)).toBe("asking GitHub");

  const refused = after(connected, [Message.RejectedGitHub({ wording: "Nothing to authorize." })]);

  expect(shownText(refused, ID.githubState)).toBe("connected");
  expect(shownText(refused, ID.githubDetail)).toBe("Nothing to authorize.");

  const failed = after(connected, [Message.FailedGitHub({ detail: "offline" })]);

  expect(shownText(failed, ID.githubDetail)).toBe("");
});

test.each([
  {
    refusal: "a mistyped repository URL",
    code: "invalid-repository-url",
    status: 400,
  },
  { refusal: "a connect during a workspace reset", code: "workspace-busy", status: 409 },
])("$refusal leaves the GitHub panel showing the stored status", async ({ code, status }) => {
  const connected = after(init().model, [
    Message.SucceededGitHub({
      github: gitHubReport(CONNECTED_GITHUB, LATE_MORNING, LATE_MORNING),
    }),
    Message.UpdatedConnectRepositoryInput({ value: "https:/github.com/octocat" }),
  ]);

  const done = await settled(update(connected, Message.ClickedConnect()), ({ method }) =>
    Promise.resolve(
      method === "POST"
        ? Response.json({ ok: false, problem: { code, detail: "" } }, { status })
        : Response.json({ ok: true, github: CONNECTED_GITHUB, checkedAt: LATE_MORNING }),
    ),
  );

  expect(done.sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
    "POST /api/projects/connect",
    "GET /api/github/connection",
  ]);
  expect(shownText(done.model, ID.githubState)).toBe("connected");
  expect(shownText(done.model, ID.githubDetail)).toBe("octocat (device-authorization)");
  expect(shownText(done.model, ID.connectStatus)).toBe(refusalText({ kind: "problem", code }));
});
