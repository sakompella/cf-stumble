import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Option from "effect/Option";
import { expect, test } from "vitest";
import type { AgentEvent } from "../../../src/page/client/events.js";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { init, update } from "../../../src/page/client/update.js";

const PROJECT_IDS = ["repo", "harness"] as const;

const PROJECTS = [
  { id: "repo", displayName: "hello-world", isHarness: false, location: "https://github.com/o/r" },
  { id: "harness", displayName: "harness", isHarness: true, location: "/workspace/harness" },
];

const EVENTS: readonly AgentEvent[] = [
  { type: "snapshot", entries: [], tools: [], inbox: [] },
  { type: "run_start", inputs: [1] },
  {
    type: "message_end",
    entry: { id: 7, kind: "pi.user", model: [{ role: "user", content: "OLD" }] },
  },
  { type: "inbox_update", items: [{ id: 2 }] },
  { type: "submission", record: { id: 2, requestId: "r", status: "done" } },
  { type: "run_end", inputs: [1] },
];

type Step = (model: Model, tc: hegel.TestCase) => Message;

const STEPS: readonly Step[] = [
  (_model, tc) => Message.ClickedProject({ projectId: tc.draw(gs.sampledFrom(PROJECT_IDS)) }),
  () => Message.UpdatedPrompt({ value: "do it" }),
  () => Message.ClickedSendTurn(),
  () => Message.ClickedCancelTurn(),
  () => Message.ClickedFreshThread(),
  (model, tc) =>
    Message.ReceivedEvent({
      streamId: model.eventsStreamId,
      event: tc.draw(gs.sampledFrom(EVENTS)),
    }),
  (model) => Message.SucceededFreshThread({ streamId: model.eventsStreamId }),
];

const STALE: readonly Step[] = [
  (model, tc) =>
    Message.ReceivedEvent({
      streamId: staleStream(model, tc),
      event: tc.draw(gs.sampledFrom(EVENTS)),
    }),
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
  () => Message.ClickedAuthorize({ path: "/api/github/authorization" }),
];

const CONNECTED_CHATGPT = { connection: "connected", isConnected: true, maybeLogin: Option.none() };

function listedPage(): Model {
  return update(init().model, Message.SucceededFetchProjects({ projects: PROJECTS })).model;
}

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
