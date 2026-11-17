import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Option from "effect/Option";
import { expect, test } from "vitest";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { subscriptions } from "../../../src/page/client/subscriptions.js";
import { init, update } from "../../../src/page/client/update.js";

const PROJECT_IDS = ["repo", "harness"] as const;

const PROJECTS = [
  { id: "repo", displayName: "hello-world", isHarness: false, location: "https://github.com/o/r" },
  { id: "harness", displayName: "harness", isHarness: true, location: "/workspace/harness" },
];

const events = subscriptions["events"];

if (events === undefined) {
  throw new Error("the page has no events subscription");
}

function nextMessage(model: Model, tc: hegel.TestCase): Message {
  const streamId = tc.draw(gs.integers({ minValue: 0, maxValue: model.eventsStreamId + 1 }));
  const projectId = tc.draw(gs.sampledFrom(PROJECT_IDS));

  return tc.draw(
    gs.sampledFrom([
      Message.ClickedProject({ projectId }),
      Message.SucceededFreshThread({ streamId: model.eventsStreamId }),
      Message.AcquiredTranscript({ streamId, projectId }),
      Message.ReleasedTranscript(),
    ]),
  );
}

test("the page reads events only for the project and stream it shows now", () => {
  hegel.test(
    (tc) => {
      let model = update(
        init().model,
        Message.SucceededFetchProjects({ projects: PROJECTS }),
      ).model;

      for (let count = tc.draw(gs.integers({ minValue: 1, maxValue: 20 })); count > 0; count -= 1) {
        const message = nextMessage(model, tc);
        tc.note(message._tag);
        model = update(model, message).model;

        const { maybeStream } = events.modelToDependencies(model);

        expect(
          Option.isNone(maybeStream) ||
            (Option.contains(model.maybeProjectId, maybeStream.value.projectId) &&
              maybeStream.value.streamId === model.eventsStreamId),
          message._tag,
        ).toBe(true);
      }
    },
    { testCases: 300 },
  );
});
