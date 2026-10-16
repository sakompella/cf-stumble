/**
 * What a screen reader hears when a turn ends. The page keeps one polite live region, the turn's
 * own state line, so a reader is told how the turn ended once and is not read each streamed token.
 */

import * as Predicate from "effect/Predicate";
import { Scene } from "foldkit/test";
import { expect, test } from "vitest";
import type { TurnFrame } from "../../../src/page/client/frames.js";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { FollowTranscript } from "../../../src/page/client/mount.js";
import { init, update } from "../../../src/page/client/update.js";
import { view } from "../../../src/page/client/view.js";

type Rendered = NonNullable<ReturnType<typeof view>>;

const PROJECT = { id: "repo", displayName: "hello-world", isHarness: false, location: "o/r" };

const THREAD = { revision: "3", turnActive: "no", messageCount: "0", conversation: "[]" };

function after(start: Model, messages: readonly Message[]): Model {
  return messages.reduce((model, message) => update(model, message).model, start);
}

function turnWithFrames(frames: readonly TurnFrame[]): Model {
  const sent = after(init().model, [
    Message.SucceededFetchProjects({ projects: [PROJECT], github: { _tag: "Unknown" } }),
    Message.SucceededFetchThread({ selection: 1, isQuiet: false, thread: THREAD }),
    Message.UpdatedPrompt({ value: "do it" }),
    Message.ClickedSendTurn(),
  ]);

  return after(
    sent,
    frames.map((frame) => Message.ReceivedTurnFrame({ turnId: sent.turnCount, frame })),
  );
}

function liveRegions(node: Rendered | string): readonly Rendered[] {
  if (Predicate.isString(node)) {
    return [];
  }

  const isLive = node.data?.attrs?.["aria-live"] !== undefined;

  return [...(isLive ? [node] : []), ...(node.children ?? []).flatMap(liveRegions)];
}

function textOf(node: Rendered | string): string {
  return Predicate.isString(node)
    ? node
    : (node.text ?? "") + (node.children ?? []).map(textOf).join("");
}

function announced(model: Model): readonly Readonly<{ politeness: unknown; text: string }>[] {
  let html: Rendered | undefined;

  Scene.scene(
    { update, view },
    Scene.given(model),
    Scene.tap((simulation) => {
      html = simulation.html;
    }),
    Scene.Mount.resolve(FollowTranscript, Message.CompletedFollowTranscript()),
  );

  return (html === undefined ? [] : liveRegions(html)).map((region) => ({
    politeness: region.data?.attrs?.["aria-live"],
    text: textOf(region),
  }));
}

test("the turn's terminal status is the one polite announcement", () => {
  const ended = turnWithFrames([{ kind: "saved", revision: 4, messageCount: 2 }]);

  expect(announced(ended)).toEqual([
    { politeness: "polite", text: "saved · revision 4 · 2 messages" },
  ]);
});

test("streamed text does not change what the live region holds", () => {
  const running = announced(turnWithFrames([]));

  const streaming = announced(
    turnWithFrames([
      { kind: "text", text: "first" },
      { kind: "text", text: " second" },
    ]),
  );

  expect(streaming).toEqual(running);
  expect(streaming).toEqual([{ politeness: "polite", text: "running" }]);
});
