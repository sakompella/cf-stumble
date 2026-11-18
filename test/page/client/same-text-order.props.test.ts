import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expect, test } from "vitest";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { init, update } from "../../../src/page/client/update.js";
import { rowsShown } from "./shown.js";
import { acquired, entryItem, received, running, viewing } from "./views.js";

const PROJECTS = [
  { id: "repo", displayName: "repo", isHarness: false, location: "https://github.com/o/r" },
];

const FATES = ["never reached", "answered", "answer lost"] as const;

type Send = Readonly<{ requestId: string; fate: (typeof FATES)[number] }>;

type Run = { model: Model; reached: string[]; shownCount: number };

const Posted = Schema.decodeUnknownSync(Schema.Struct({ requestId: Schema.String }));

const userEntry = (id: number, content: string) => entryItem(id, { role: "user", content });

function pageAtEntry10(): Model {
  const listed = update(init().model, Message.SucceededFetchProjects({ projects: PROJECTS })).model;
  const held = update(listed, acquired(listed)).model;

  return update(
    held,
    received(held, viewing({ maybeId: Option.some(1), items: [userEntry(10, "earlier")] })),
  ).model;
}

function events(send: Send, index: number): ((run: Run) => readonly Message[])[] {
  const { requestId, fate } = send;

  const minted = () => [
    Message.MintedRequestId({
      projectId: "repo",
      requestId,
      content: "continue",
      conversationId: 1,
    }),
  ];

  if (fate === "never reached")
    return [minted, () => [Message.FailedSend({ requestId, detail: "Failed to fetch" })]];

  const reaches = (run: Run) => {
    run.reached.push(requestId);

    return [];
  };

  const answered = () => [
    fate === "answered"
      ? Message.SucceededSend({ requestId, submissionId: index + 1 })
      : Message.FailedSend({ requestId, detail: "reply lost" }),
  ];

  return [minted, reaches, answered];
}

function view(tc: hegel.TestCase, run: Run): Message {
  run.shownCount = tc.draw(gs.integers({ minValue: run.shownCount, maxValue: run.reached.length }));

  const items = [
    userEntry(10, "earlier"),
    ...run.reached.slice(0, run.shownCount).map((_, index) => userEntry(11 + index, "continue")),
  ];

  return received(
    run.model,
    (tc.draw(gs.booleans()) ? running : viewing)({ maybeId: Option.some(1), items }),
  );
}

function resent(model: Model): readonly string[] {
  return (update(model, Message.ChangedConnectivity({ isOnline: true })).commands ?? [])
    .filter((command) => command.name === "SendMessage")
    .map((command) => Posted(command.args).requestId);
}

test("a same-text send that never reached the Worker is sent again when the connection is back, whatever order the other sends' answers and the views arrive in", () => {
  hegel.test(
    (tc) => {
      const sends = Array.from(
        { length: tc.draw(gs.integers({ minValue: 2, maxValue: 4 })) },
        (_, index): Send => ({ requestId: `r${index}`, fate: tc.draw(gs.sampledFrom(FATES)) }),
      );

      const pending = sends.map(events);
      const run: Run = { model: pageAtEntry10(), reached: [], shownCount: 0 };

      const apply = (messages: readonly Message[]) => {
        run.model = messages.reduce((model, message) => update(model, message).model, run.model);
      };

      for (let open = pending.filter((queue) => queue.length > 0); open.length > 0;) {
        if (tc.draw(gs.booleans())) apply([view(tc, run)]);

        apply(tc.draw(gs.sampledFrom(open)).shift()?.(run) ?? []);
        open = pending.filter((queue) => queue.length > 0);
      }

      apply([view(tc, run)]);

      const neverReached = sends.filter((send) => send.fate === "never reached");

      expect(resent(run.model)).toEqual(
        expect.arrayContaining(neverReached.map((send) => send.requestId)),
      );
      expect(
        rowsShown(run.model).filter((row) => row.who === "you · not confirmed").length,
      ).toBeGreaterThanOrEqual(neverReached.length);
    },
    { testCases: 300 },
  );
});
