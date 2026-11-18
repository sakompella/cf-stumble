import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expect, test } from "vitest";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { init, update } from "../../../src/page/client/update.js";
import { promptShown } from "./shown.js";
import { acquired, received, running, viewing } from "./views.js";

const PROJECTS = [
  { id: "repo", displayName: "repo", isHarness: false, location: "https://github.com/o/r" },
];

const ACTIONS = [
  "write",
  "handle",
  "click",
  "replace",
  "fresh-answer",
  "view",
  "interrupt",
  "online",
  "retry",
] as const;

const FATES = ["answered", "answer lost", "never reached", "held"] as const;

const Minting = Schema.decodeUnknownSync(
  Schema.Struct({ projectId: Schema.String, content: Schema.String }),
);

const Posted = Schema.decodeUnknownSync(
  Schema.Struct({
    requestId: Schema.String,
    content: Schema.String,
    conversationId: Schema.optional(Schema.Number),
  }),
);

type Post = ReturnType<typeof Posted>;

type Run = {
  model: Model;
  serving: number;
  replacing: "no" | "sent" | "done";
  written: number;
  inFlight: Post[];
  admitted: Map<string, Readonly<{ text: string; conversations: Set<number> }>>;
};

function apply(run: Run, message: Message): void {
  const next = update(run.model, message);

  run.model = next.model;

  for (const command of next.commands ?? []) {
    if (command.name === "ReplaceThread") run.replacing = "sent";

    if (command.name === "SendMessage") run.inFlight.push(Posted(command.args));

    if (command.name === "MintRequestId") {
      const requestId = `r${run.written}`;
      const conversationId = Option.getOrElse(run.model.conversation.maybeId, () => 0);

      apply(run, Message.MintedRequestId({ ...Minting(command.args), requestId, conversationId }));
    }
  }
}

function handled(tc: hegel.TestCase, run: Run, post: Post): Message {
  const { requestId } = post;

  if (post.conversationId !== undefined && post.conversationId !== run.serving)
    return Message.RejectedSend({ requestId, wording: "thread replaced" });

  const fate = tc.draw(gs.sampledFrom(FATES));

  if (fate === "held") return Message.HeldSend({ requestId, wording: "held" });

  if (fate === "never reached") return Message.FailedSend({ requestId, detail: "offline" });

  const known = run.admitted.get(requestId) ?? { text: post.content, conversations: new Set() };

  known.conversations.add(run.serving);
  run.admitted.set(requestId, known);

  return fate === "answered"
    ? Message.SucceededSend({ requestId, submissionId: 7 })
    : Message.FailedSend({ requestId, detail: "reply lost" });
}

function freshAnswer(tc: hegel.TestCase, run: Run): Message {
  const streamId = run.model.eventsStreamId;
  const replaced = run.replacing === "done" && tc.draw(gs.booleans());

  run.replacing = "no";

  return replaced
    ? Message.SucceededFreshThread({ streamId, conversationId: String(run.serving) })
    : Message.FailedFreshThread({ streamId, detail: "reply lost" });
}

function step(tc: hegel.TestCase, run: Run): void {
  const action = tc.draw(gs.sampledFrom(ACTIONS));
  const streamId = run.model.eventsStreamId;

  if (action === "write") {
    run.written += 1;
    apply(run, Message.UpdatedPrompt({ value: `<t${run.written}>` }));
    apply(run, Message.ClickedSendTurn());
  } else if (action === "handle" && run.inFlight.length > 0) {
    const index = tc.draw(gs.integers({ minValue: 0, maxValue: run.inFlight.length - 1 }));

    apply(run, handled(tc, run, run.inFlight.splice(index, 1)[0]!));
  } else if (action === "click") {
    apply(run, Message.ClickedFreshThread());
    apply(run, Message.ClickedFreshThread());
  } else if (action === "replace" && run.replacing === "sent") {
    run.serving += 1;
    run.replacing = "done";
  } else if (action === "fresh-answer" && run.replacing !== "no") apply(run, freshAnswer(tc, run));
  else if (action === "view")
    apply(
      run,
      received(
        run.model,
        (tc.draw(gs.booleans()) ? running : viewing)({ maybeId: Option.some(run.serving) }),
      ),
    );
  else if (action === "interrupt")
    apply(run, Message.DisconnectedEvents({ streamId, detail: "dropped" }));
  else if (action === "online") apply(run, Message.ChangedConnectivity({ isOnline: true }));
  else if (action === "retry")
    for (const { requestId } of run.model.outgoing)
      apply(run, Message.ClickedRetrySend({ requestId }));
}

function pageOnConversation1(): Model {
  const listed = update(init().model, Message.SucceededFetchProjects({ projects: PROJECTS })).model;
  const held = update(listed, acquired(listed)).model;

  return update(held, received(held, viewing({ maybeId: Option.some(1) }))).model;
}

test("a message reaches at most one conversation, and its text is not back in the prompt when it reached the current one, whatever retries, fresh threads and views come between", () => {
  hegel.test(
    (tc) => {
      const run: Run = {
        model: pageOnConversation1(),
        serving: 1,
        replacing: "no",
        written: 0,
        inFlight: [],
        admitted: new Map(),
      };

      for (let index = tc.draw(gs.integers({ minValue: 1, maxValue: 30 })); index > 0; index -= 1)
        step(tc, run);

      for (const [requestId, { text, conversations }] of run.admitted) {
        expect(conversations.size, requestId).toBe(1);

        if (conversations.has(run.serving))
          expect(promptShown(run.model), requestId).not.toContain(text);
      }
    },
    { testCases: 1000 },
  );
});
