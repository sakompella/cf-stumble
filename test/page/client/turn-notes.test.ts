import * as Option from "effect/Option";
import { expect, test } from "vitest";
import { subscriptions } from "../../../src/page/client/subscriptions.js";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { init, update } from "../../../src/page/client/update.js";
import { freshShown, runShown } from "./shown.js";
import { received, running, viewing } from "./views.js";

const PROJECTS = [
  { id: "repo", displayName: "hello-world", isHarness: false, location: "https://github.com/o/r" },
];

function readyPage(): Model {
  const listed = update(init().model, Message.SucceededFetchProjects({ projects: PROJECTS })).model;

  return update(listed, received(listed, viewing())).model;
}

function shows(model: Model, conversation: ReturnType<typeof viewing>): Model {
  return update(model, received(model, conversation)).model;
}

function cancelled(model: Model): Model {
  return shows(
    update(model, Message.ClickedCancelTurn()).model,
    viewing({ maybeRunFailure: Option.some("aborted") }),
  );
}

test("a cancel that withdraws queued messages says how many", () => {
  const one = shows(readyPage(), running({ inbox: [{ id: 2, text: "one" }] }));

  expect(runShown(cancelled(one))).toBe("stopped: aborted · 1 queued message withdrawn");

  const two = shows(
    readyPage(),
    running({
      inbox: [
        { id: 2, text: "one" },
        { id: 3, text: "two" },
      ],
    }),
  );

  expect(runShown(cancelled(two))).toBe("stopped: aborted · 2 queued messages withdrawn");
  expect(runShown(cancelled(shows(readyPage(), running())))).toBe("stopped: aborted");
});

test("an armed fresh thread goes back to idle when its confirmation expires", () => {
  const armed = update(readyPage(), Message.ClickedFreshThread()).model;
  const expiry = subscriptions["freshThreadExpiry"];

  expect(expiry?.modelToDependencies(armed)).toEqual({ isArmed: true });
  expect(expiry?.modelToDependencies(readyPage())).toEqual({ isArmed: false });
  expect(freshShown(update(armed, Message.ExpiredFreshThread()).model)).toBe("");
});

test("a fresh thread that has already started is not undone by an old expiry", () => {
  const armed = update(readyPage(), Message.ClickedFreshThread()).model;
  const starting = update(armed, Message.ClickedFreshThread()).model;

  expect(freshShown(update(starting, Message.ExpiredFreshThread()).model)).toBe(
    "starting a fresh thread",
  );
});
