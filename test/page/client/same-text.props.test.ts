import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Option from "effect/Option";
import { expect, test } from "vitest";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { init, update } from "../../../src/page/client/update.js";
import { rowsShown } from "./shown.js";
import { acquired, entryItem, received, running, streaming, viewing } from "./views.js";

const PROJECTS = [
  { id: "repo", displayName: "repo", isHarness: false, location: "https://github.com/o/r" },
];

type Send = Readonly<{ requestId: string; text: string; arrives: boolean; failsLate: boolean }>;

const userEntry = (id: number, content: string) => entryItem(id, { role: "user", content });

function after(model: Model, messages: readonly ((model: Model) => Message)[]): Model {
  return messages.reduce((current, message) => update(current, message(current)).model, model);
}

function pageAtEntry10(): Model {
  return after(init().model, [
    () => Message.SucceededFetchProjects({ projects: PROJECTS }),
    acquired,
    (model) =>
      received(model, viewing({ maybeId: Option.some(1), items: [userEntry(10, "earlier")] })),
  ]);
}

const failures = (sends: readonly Send[], late: boolean) =>
  sends.flatMap((send) =>
    send.failsLate === late
      ? [() => Message.FailedSend({ requestId: send.requestId, detail: "Failed to fetch" })]
      : [],
  );

const shownTexts = (model: Model, who: string): readonly string[] =>
  rowsShown(model)
    .filter((row) => row.who === who)
    .map((row) => row.text)
    .toSorted();

function drawnSends(tc: hegel.TestCase): readonly Send[] {
  return tc
    .draw(gs.arrays(gs.sampledFrom(["continue", "yes"]), { minSize: 2, maxSize: 5 }))
    .map((text, index) => ({
      requestId: `r${index}`,
      text,
      arrives: tc.draw(gs.booleans()),
      failsLate: tc.draw(gs.booleans()),
    }));
}

test("a send that never reached the Worker stays not confirmed while sends with the same text reach it, however often the stream shows their entries", () => {
  hegel.test(
    (tc) => {
      const sends = drawnSends(tc);

      const arrived = sends.filter((send) => send.arrives);
      const unsent = sends.filter((send) => !send.arrives);

      const items = [
        userEntry(10, "earlier"),
        ...arrived.map((send, index) => userEntry(11 + index, send.text)),
      ];

      const views = Array.from(
        { length: tc.draw(gs.integers({ minValue: 1, maxValue: 3 })) },
        (_, step) => (model: Model) =>
          received(
            model,
            running({ maybeId: Option.some(1), items, maybePartial: streaming(`step ${step}`) }),
          ),
      );

      const model = after(pageAtEntry10(), [
        ...sends.map(
          (send) => () =>
            Message.MintedRequestId({
              projectId: "repo",
              requestId: send.requestId,
              content: send.text,
              conversationId: 1,
            }),
        ),
        ...arrived.map(
          (send, index) => () =>
            Message.SucceededSend({ requestId: send.requestId, submissionId: index + 1 }),
        ),
        ...failures(unsent, false),
        ...views,
        ...failures(unsent, true),
      ]);

      expect(shownTexts(model, "you · not confirmed")).toEqual(
        unsent.map((send) => send.text).toSorted(),
      );
      expect(shownTexts(model, "you")).toEqual(
        ["earlier", ...arrived.map((send) => send.text)].toSorted(),
      );
    },
    { testCases: 300 },
  );
});
