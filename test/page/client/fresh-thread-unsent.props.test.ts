import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expect, test } from "vitest";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { init, update } from "../../../src/page/client/update.js";
import { promptShown, runShown, whoShown } from "./shown.js";
import { acquired, entryItem, received, viewing } from "./views.js";

const PROJECTS = [
  { id: "repo", displayName: "repo", isHarness: false, location: "https://github.com/o/r" },
];

type Step = (model: Model) => Message;

type Send = Readonly<{
  requestId: string;
  text: string;
  before: "lost" | "pending" | "queued";
  late: Step;
}>;

const SentRequest = Schema.decodeUnknownSync(Schema.Struct({ requestId: Schema.String }));

const INTERRUPTIONS: readonly Step[] = [
  (model) => Message.DisconnectedEvents({ streamId: model.eventsStreamId, detail: "dropped" }),
  (model) => Message.RefusedEvents({ streamId: model.eventsStreamId, wording: "busy" }),
  (model) => Message.ReceivedUnreadableEvent({ streamId: model.eventsStreamId }),
];

const freshView: Step = (model) => received(model, viewing({ maybeId: Option.some(2) }));

const REPLACEMENTS: readonly (readonly Step[])[] = [
  [
    () => Message.ClickedFreshThread(),
    () => Message.ClickedFreshThread(),
    (model) =>
      Message.SucceededFreshThread({ streamId: model.eventsStreamId, conversationId: "2" }),
    freshView,
  ],
  [freshView],
];

function lateOutcomes(requestId: string): readonly Step[] {
  return [
    () => Message.FailedSend({ requestId, detail: "Failed to fetch" }),
    () => Message.HeldSend({ requestId, wording: "held" }),
    () => Message.RejectedSend({ requestId, wording: "busy" }),
    () => Message.SucceededSend({ requestId, submissionId: 9 }),
  ];
}

function drawnSends(tc: hegel.TestCase): readonly Send[] {
  return Array.from({ length: tc.draw(gs.integers({ minValue: 1, maxValue: 3 })) }, (_, index) => {
    const requestId = `old${index}`;

    return {
      requestId,
      text: `<t${index}>`,
      before: tc.draw(gs.sampledFrom(["lost", "pending", "queued"] as const)),
      late: tc.draw(gs.sampledFrom(lateOutcomes(requestId))),
    };
  });
}

function beforeReplacement(send: Send): readonly Step[] {
  const minted: Step = () =>
    Message.MintedRequestId({
      projectId: "repo",
      requestId: send.requestId,
      content: send.text,
      conversationId: 1,
    });

  if (send.before === "lost")
    return [minted, () => Message.FailedSend({ requestId: send.requestId, detail: "offline" })];

  if (send.before === "queued")
    return [minted, () => Message.SucceededSend({ requestId: send.requestId, submissionId: 4 })];

  return [minted];
}

function drawnAftermath(tc: hegel.TestCase, sends: readonly Send[]): readonly Step[] {
  const choices: readonly (readonly Step[])[] = [
    [() => Message.ChangedConnectivity({ isOnline: true })],
    [tc.draw(gs.sampledFrom(INTERRUPTIONS)), freshView],
    sends.map((send) => () => Message.ClickedRetrySend({ requestId: send.requestId })),
  ];

  return Array.from({ length: tc.draw(gs.integers({ minValue: 0, maxValue: 4 })) }, () =>
    tc.draw(gs.sampledFrom(choices)),
  ).flat();
}

function pageOnConversation1(): Model {
  const listed = update(init().model, Message.SucceededFetchProjects({ projects: PROJECTS })).model;
  const held = update(listed, acquired(listed)).model;
  const userEntry = entryItem(10, { role: "user", content: "earlier" });

  return update(held, received(held, viewing({ maybeId: Option.some(1), items: [userEntry] })))
    .model;
}

function ran(start: Model, steps: readonly Step[]): { model: Model; sentIds: string[] } {
  return steps.reduce<{ model: Model; sentIds: string[] }>(
    ({ model, sentIds }, step) => {
      const next = update(model, step(model));
      const sends = (next.commands ?? []).filter((command) => command.name === "SendMessage");

      return {
        model: next.model,
        sentIds: [...sentIds, ...sends.map((command) => SentRequest(command.args).requestId)],
      };
    },
    { model: start, sentIds: [] },
  );
}

test("a message not admitted before its conversation was replaced is never sent into the new thread, and its text comes back to the prompt once", () => {
  hegel.test(
    (tc) => {
      const sends = drawnSends(tc);
      const interrupted = tc.draw(gs.booleans());

      const before = ran(pageOnConversation1(), [
        ...sends.flatMap(beforeReplacement),
        ...(interrupted ? [tc.draw(gs.sampledFrom(INTERRUPTIONS))] : []),
      ]).model;

      const replaced = ran(before, [
        ...tc.draw(gs.sampledFrom(REPLACEMENTS)),
        ...sends.flatMap((send) => (send.before === "pending" ? [send.late] : [])),
        ...drawnAftermath(tc, sends),
      ]);

      expect(replaced.sentIds).toEqual([]);
      expect(whoShown(replaced.model)).not.toContain("you · not confirmed");
      expect(runShown(replaced.model)).not.toContain("not confirmed");

      for (const send of sends)
        expect(promptShown(replaced.model).split(send.text).length - 1, send.text).toBe(
          send.before === "queued" ? 0 : 1,
        );
    },
    { testCases: 300 },
  );
});
