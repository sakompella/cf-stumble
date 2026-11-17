import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expect, test } from "vitest";
import { chatGPTConnection } from "../../../src/page/client/chatgpt.js";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { init, update } from "../../../src/page/client/update.js";
import { entryItem, running, viewing, type Conversation } from "./views.js";

const PROJECT_IDS = ["repo", "harness"] as const;

const REQUEST_IDS = ["r1", "r2"] as const;

const PROJECTS = [
  { id: "repo", displayName: "hello-world", isHarness: false, location: "https://github.com/o/r" },
  { id: "harness", displayName: "harness", isHarness: true, location: "/workspace/harness" },
];

const VIEWS: readonly Conversation[] = [
  viewing(),
  running(),
  viewing({ items: [entryItem(7, { role: "user", content: "OLD" })] }),
  running({ inbox: [{ id: 2, text: "queued" }] }),
  viewing({ maybeRunFailure: Option.some("aborted") }),
];

type Step = (model: Model, tc: hegel.TestCase) => Message;

const STEPS: readonly Step[] = [
  (_model, tc) => Message.ClickedProject({ projectId: tc.draw(gs.sampledFrom(PROJECT_IDS)) }),
  () => Message.UpdatedPrompt({ value: "do it" }),
  () => Message.ClickedSendTurn(),
  () => Message.ClickedCancelTurn(),
  () => Message.ClickedFreshThread(),
  (model, tc) =>
    Message.ReceivedConversation({
      streamId: model.eventsStreamId,
      conversation: tc.draw(gs.sampledFrom(VIEWS)),
    }),
  (model) => Message.SucceededFreshThread({ streamId: model.eventsStreamId }),
  (model, tc) =>
    Message.MintedRequestId({
      projectId: Option.getOrElse(model.maybeProjectId, () => "repo"),
      requestId: tc.draw(gs.sampledFrom(REQUEST_IDS)),
      content: "sent",
    }),
  (_model, tc) =>
    Message.SucceededSend({
      requestId: tc.draw(gs.sampledFrom(REQUEST_IDS)),
      submissionId: tc.draw(gs.sampledFrom([2, 9])),
    }),
];

const STALE: readonly Step[] = [
  (model, tc) =>
    Message.ReceivedConversation({
      streamId: staleStream(model, tc),
      conversation: tc.draw(gs.sampledFrom(VIEWS)),
    }),
  (model, tc) =>
    Message.LoadedTranscript({ streamId: staleStream(model, tc), maybeItems: Option.some([]) }),
  (model, tc) => Message.FailedLoadTranscript({ streamId: staleStream(model, tc), detail: "x" }),
  (model, tc) => Message.ReceivedUnreadableEvent({ streamId: staleStream(model, tc) }),
  (model, tc) => Message.RefusedEvents({ streamId: staleStream(model, tc), wording: "busy" }),
  (model, tc) => Message.DisconnectedEvents({ streamId: staleStream(model, tc), detail: "x" }),
  (model, tc) => Message.SucceededFreshThread({ streamId: staleStream(model, tc) }),
  (model, tc) =>
    Message.RejectedFreshThread({ streamId: staleStream(model, tc), wording: "rejected: x" }),
  (model, tc) => Message.FailedFreshThread({ streamId: staleStream(model, tc), detail: "x" }),
];

function staleStream(model: Model, tc: hegel.TestCase): number {
  return tc.draw(gs.integers({ minValue: 0, maxValue: model.eventsStreamId - 1 }));
}

const ANSWERS: readonly Step[] = [
  () => Message.SucceededGitHub({ github: { _tag: "Unknown" } }),
  () => Message.RejectedGitHub({ wording: "rejected: x" }),
  () => Message.FailedGitHub({ detail: "x" }),
  () => Message.SucceededChatGPT({ chatgpt: CONNECTED_CHATGPT }),
  () => Message.SucceededFetchProjects({ projects: PROJECTS }),
  () => Message.ClickedAuthorize({ endpoint: "POST /api/github/authorization" }),
];

const CONNECTED_CHATGPT = chatGPTConnection({
  connection: { state: "connected", expiresAt: 1 },
  login: null,
  model: "gpt",
});

function listedPage(): Model {
  return update(init().model, Message.SucceededFetchProjects({ projects: PROJECTS })).model;
}

function stepped(tc: hegel.TestCase, steps: readonly Step[]): Model {
  let model = listedPage();

  for (let count = tc.draw(gs.integers({ minValue: 0, maxValue: 12 })); count > 0; count -= 1) {
    const message = tc.draw(gs.sampledFrom(steps))(model, tc);
    tc.note(message._tag);
    model = update(model, message).model;
  }

  return model;
}

test("showing the view the page already shows again changes nothing and asks nothing", () => {
  hegel.test(
    (tc) => {
      const model = stepped(tc, STEPS);

      const view = Message.ReceivedConversation({
        streamId: model.eventsStreamId,
        conversation: tc.draw(gs.sampledFrom(VIEWS)),
      });

      const shown = update(model, view).model;
      const again = update(shown, view);

      expect(again.model).toEqual(shown);
      expect(again.commands ?? []).toEqual([]);
    },
    { testCases: 300 },
  );
});

test("a queued answer or event for a stream the page replaced changes nothing", () => {
  hegel.test(
    (tc) => {
      const steps = tc.draw(gs.integers({ minValue: 0, maxValue: 12 }));
      let model = listedPage();

      for (let index = 0; index < steps; index += 1) {
        const step = tc.draw(gs.sampledFrom(STEPS));
        model = update(model, step(model, tc)).model;
      }

      const stale = tc.draw(gs.sampledFrom(STALE))(model, tc);
      const after = update(model, stale);

      expect(after.model, stale._tag).toEqual(model);
      expect(after.commands ?? [], stale._tag).toEqual([]);
    },
    { testCases: 300 },
  );
});

test("clicking the project that is already selected changes nothing", () => {
  hegel.test(
    (tc) => {
      const steps = tc.draw(gs.integers({ minValue: 0, maxValue: 12 }));
      let model = listedPage();

      for (let index = 0; index < steps; index += 1) {
        model = update(model, tc.draw(gs.sampledFrom(STEPS))(model, tc)).model;
      }

      const selected = Option.getOrThrow(model.maybeProjectId);
      const after = update(model, Message.ClickedProject({ projectId: selected }));

      expect(after.model).toEqual(model);
      expect(after.commands ?? []).toEqual([]);
    },
    { testCases: 300 },
  );
});

test("only the owner's own request checks the GitHub connection again after the page loads", () => {
  hegel.test(
    (tc) => {
      const steps = tc.draw(gs.integers({ minValue: 1, maxValue: 12 }));
      let model = listedPage();

      for (let index = 0; index < steps; index += 1) {
        const message = tc.draw(gs.sampledFrom([...STEPS, ...ANSWERS]))(model, tc);
        const next = update(model, message);
        const names = (next.commands ?? []).map((command) => command.name);

        expect(names, message._tag).not.toContain("RefreshGitHub");
        model = next.model;
      }
    },
    { testCases: 300 },
  );
});

const FRESH_THREAD_ANSWERS = [
  (streamId: number) => Message.SucceededFreshThread({ streamId }),
  (streamId: number) => Message.RejectedFreshThread({ streamId, wording: "rejected: x" }),
  (streamId: number) => Message.FailedFreshThread({ streamId, detail: "x" }),
] as const;

const replacedStream = Schema.decodeUnknownSync(Schema.Struct({ streamId: Schema.Number }));

function answered(tc: hegel.TestCase, asked: Set<number>): Message {
  const streamId = tc.draw(gs.sampledFrom([...asked]));
  asked.delete(streamId);

  return tc.draw(gs.sampledFrom(FRESH_THREAD_ANSWERS))(streamId);
}

test("the page asks to replace a stream's thread at most once until that request is answered", () => {
  hegel.test(
    (tc) => {
      const asked = new Set<number>();
      const steps = [...STEPS, () => Message.ClickedFreshThread()];
      let model = listedPage();

      for (let count = tc.draw(gs.integers({ minValue: 1, maxValue: 30 })); count > 0; count -= 1) {
        const message =
          asked.size > 0 && tc.draw(gs.booleans())
            ? answered(tc, asked)
            : tc.draw(gs.sampledFrom(steps))(model, tc);

        tc.note(message._tag);

        const next = update(model, message);

        for (const command of next.commands ?? []) {
          if (command.name !== "ReplaceThread") continue;

          const { streamId } = replacedStream(command.args);

          expect(asked.has(streamId), message._tag).toBe(false);
          asked.add(streamId);
        }

        model = next.model;
      }
    },
    { testCases: 300 },
  );
});

const REPO_ONLY = PROJECTS.filter((project) => !project.isHarness);

const HARNESS_ONLY = PROJECTS.filter((project) => project.isHarness);

const THIRD = {
  id: "third",
  displayName: "third",
  isHarness: false,
  location: "https://github.com/o/t",
};

const LISTS = [PROJECTS, HARNESS_ONLY, REPO_ONLY, [], [...REPO_ONLY, THIRD, ...HARNESS_ONLY]];

test("whatever the project list answers, the selected project is one of the listed ones, and one is selected whenever any is listed", () => {
  hegel.test(
    (tc) => {
      let model = listedPage();

      for (let count = tc.draw(gs.integers({ minValue: 1, maxValue: 12 })); count > 0; count -= 1) {
        const message = tc.draw(
          gs.sampledFrom([
            Message.ClickedProject({ projectId: tc.draw(gs.sampledFrom(["repo", "third"])) }),
            Message.SucceededFetchProjects({ projects: tc.draw(gs.sampledFrom(LISTS)) }),
          ]),
        );

        tc.note(message._tag);
        model = update(model, message).model;

        const listed = model.projects.map((project) => project.id);

        expect(
          Option.match(model.maybeProjectId, {
            onNone: () => listed.length === 0,
            onSome: (selected) => listed.includes(selected),
          }),
        ).toBe(true);
      }
    },
    { testCases: 300 },
  );
});
