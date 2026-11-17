import { expect, test } from "vitest";
import { checkedWording, refusalText } from "../../../src/page/client/api.js";
import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { init, update } from "../../../src/page/client/update.js";
import { AWAITING, CONNECTED, LATE_MORNING, readingGitHub } from "./github-answers.js";
import { settled } from "./requests.js";
import { shownText } from "./shown.js";

const checkedShown = (model: Model): string => shownText(model, ID.githubChecked);

function after(start: Model, messages: readonly Message[]): Model {
  return messages.reduce((model, message) => update(model, message).model, start);
}

test("asking to refresh GitHub posts the refresh request and renders the Worker's answer", async () => {
  const done = await settled(update(init().model, Message.ClickedRefreshGitHub()), () =>
    Promise.resolve(Response.json({ ok: true, github: CONNECTED, checkedAt: LATE_MORNING })),
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

test("a pending authorization is the Worker's live state, so it shows no check time", async () => {
  const shown = await readingGitHub(AWAITING);

  expect(shownText(shown, ID.githubDetail)).toBe("enter code WDJB-MJHT at GitHub");
  expect(shownText(shown, ID.githubVerificationLink)).toBe("https://github.com/login/device");
  expect(checkedShown(shown)).toBe("");
});

test("a refused or failed GitHub request keeps the stored state, login and check time, and says why in the result", async () => {
  const connected = await readingGitHub(CONNECTED);
  const checked = checkedShown(connected);

  expect(checked).not.toBe("");

  const asking = after(connected, [
    Message.ClickedAuthorize({ endpoint: "POST /api/github/authorization/complete" }),
  ]);

  expect(shownText(asking, ID.githubResult)).toBe("asking GitHub");
  expect(shownText(asking, ID.githubDetail)).toBe("octocat (device-authorization)");

  const refused = after(asking, [Message.RejectedGitHub({ wording: "Nothing to authorize." })]);

  expect(shownText(refused, ID.githubState)).toBe("connected");
  expect(shownText(refused, ID.githubDetail)).toBe("octocat (device-authorization)");
  expect(checkedShown(refused)).toBe(checked);
  expect(shownText(refused, ID.githubResult)).toBe("Nothing to authorize.");

  const failed = after(asking, [Message.FailedGitHub({ detail: "offline" })]);

  expect(shownText(failed, ID.githubState)).toBe("connected");
  expect(shownText(failed, ID.githubDetail)).toBe("octocat (device-authorization)");
  expect(checkedShown(failed)).toBe(checked);
  expect(shownText(failed, ID.githubResult)).toBe("request failed");

  const answered = await readingGitHub(CONNECTED, LATE_MORNING, refused);

  expect(shownText(answered, ID.githubResult)).toBe("");
});

test.each([
  {
    refusal: "a mistyped repository URL",
    code: "invalid-repository-url",
    status: 400,
  },
  { refusal: "a connect during a workspace reset", code: "workspace-busy", status: 409 },
])("$refusal leaves the GitHub panel showing the stored status", async ({ code, status }) => {
  const typing = after(init().model, [
    Message.UpdatedConnectRepositoryInput({ value: "https:/github.com/octocat" }),
  ]);

  const connected = await readingGitHub(CONNECTED, LATE_MORNING, typing);

  const done = await settled(update(connected, Message.ClickedConnect()), ({ method }) =>
    Promise.resolve(
      method === "POST"
        ? Response.json({ ok: false, problem: { code, detail: "" } }, { status })
        : Response.json({ ok: true, github: CONNECTED, checkedAt: LATE_MORNING }),
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
