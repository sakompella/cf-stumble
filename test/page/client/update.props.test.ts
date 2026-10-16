import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import * as Option from "effect/Option";
import { expect, test } from "vitest";
import type { TurnFrame } from "../../../src/page/client/frames.js";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { init, update } from "../../../src/page/client/update.js";

/**
 * Foldkit runs `update` once per queued Message, and a request's answer or a turn's frame can wait
 * in that queue while the reader moves on. Whatever the reader did in between, an answer for a
 * project they left or a frame for a turn the page no longer streams must leave the page exactly as
 * it was and send nothing.
 */

const PROJECT_IDS = ["repo", "harness"] as const;

const PROJECTS = [
  { id: "repo", displayName: "hello-world", isHarness: false, location: "https://github.com/o/r" },
  { id: "harness", displayName: "harness", isHarness: true, location: "/workspace/harness" },
];

const THREAD = { revision: "3", turnActive: "no", messageCount: "0", conversation: "[]" };

const PROGRESS_FRAMES: readonly TurnFrame[] = [
  { kind: "text", text: "partial" },
  { kind: "tool-start", toolCallId: "t1", toolName: "read", arguments: { path: "a" } },
  {
    kind: "tool-result",
    toolCallId: "t1",
    toolName: "read",
    isError: false,
    content: "out",
    truncated: false,
  },
  { kind: "diff", content: "@@ -1 +1 @@\n-a\n+b", truncated: false },
];

const TERMINAL_FRAMES: readonly TurnFrame[] = [
  { kind: "saved", revision: 4, messageCount: 2 },
  { kind: "turn-failed", code: "model-error", saved: false },
  { kind: "cancelled" },
];

type Step = (model: Model, tc: hegel.TestCase) => Message;

function activeTurnId(model: Model): number {
  return model.turn._tag === "Streaming" ? model.turn.turnId : 0;
}

/** What a reader and the Worker can do to a page, each as the Message it would queue. */
const STEPS: readonly Step[] = [
  (_model, tc) => Message.ClickedProject({ projectId: tc.draw(gs.sampledFrom(PROJECT_IDS)) }),
  () => Message.UpdatedPrompt({ value: "do it" }),
  () => Message.ClickedSendTurn(),
  () => Message.ClickedCancelTurn(),
  () => Message.ClickedFreshThread(),
  (model, tc) =>
    Message.ReceivedTurnFrame({
      turnId: activeTurnId(model),
      frame: tc.draw(gs.sampledFrom([...PROGRESS_FRAMES, ...TERMINAL_FRAMES])),
    }),
  (model) => Message.EndedTurnStream({ turnId: activeTurnId(model) }),
  (model) =>
    Message.SucceededFetchThread({ selection: model.selection, isQuiet: false, thread: THREAD }),
];

/** An answer or a frame that belongs to an earlier selection or an earlier turn. */
const STALE: readonly Step[] = [
  (model, tc) =>
    Message.ReceivedTurnFrame({
      turnId: staleTurnId(model, tc),
      frame: tc.draw(gs.sampledFrom([...PROGRESS_FRAMES, ...TERMINAL_FRAMES])),
    }),
  (model, tc) => Message.ReceivedUnreadableFrame({ turnId: staleTurnId(model, tc) }),
  (model, tc) => Message.RefusedTurn({ turnId: staleTurnId(model, tc), wording: "busy" }),
  (model, tc) => Message.EndedTurnStream({ turnId: staleTurnId(model, tc) }),
  (model, tc) => Message.DisconnectedTurnStream({ turnId: staleTurnId(model, tc), detail: "x" }),
  (model, tc) =>
    Message.SucceededFetchThread({
      selection: staleSelection(model, tc),
      isQuiet: tc.draw(gs.booleans()),
      thread: { ...THREAD, revision: "99", conversation: '[{"role":"user","content":"OLD"}]' },
    }),
  (model, tc) =>
    Message.RejectedFetchThread({ selection: staleSelection(model, tc), wording: "rejected: x" }),
  (model, tc) => Message.FailedFetchThread({ selection: staleSelection(model, tc), detail: "x" }),
  (model, tc) =>
    Message.SucceededFreshThread({ selection: staleSelection(model, tc), thread: THREAD }),
  (model, tc) =>
    Message.RejectedFreshThread({ selection: staleSelection(model, tc), wording: "rejected: x" }),
  (model, tc) => Message.FailedFreshThread({ selection: staleSelection(model, tc), detail: "x" }),
];

/** A turn id the page issued or never issued, but not the one it is streaming. */
function staleTurnId(model: Model, tc: hegel.TestCase): number {
  const turnId = tc.draw(gs.integers({ minValue: 0, maxValue: model.turnCount + 2 }));

  return turnId === activeTurnId(model) ? turnId + model.turnCount + 3 : turnId;
}

function staleSelection(model: Model, tc: hegel.TestCase): number {
  return tc.draw(gs.integers({ minValue: 0, maxValue: Math.max(0, model.selection - 1) }));
}

/** The GitHub and ChatGPT answers a page can receive, in any order with the steps above. */
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

test("a queued answer for a left project or an ended turn changes nothing", () => {
  hegel.test(
    (tc) => {
      const steps = tc.draw(gs.integers({ minValue: 0, maxValue: 12 }));
      let model = listedPage();

      for (let index = 0; index < steps; index += 1) {
        const step = tc.draw(gs.sampledFrom(STEPS));
        model = update(model, step(model, tc)).model;
      }

      // A stale selection exists only after the reader selected a second time.
      const candidates = model.selection > 1 ? STALE : STALE.slice(0, 5);
      const stale = tc.draw(gs.sampledFrom(candidates))(model, tc);
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
