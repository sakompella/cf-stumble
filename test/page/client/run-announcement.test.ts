/**
 * What a screen reader hears when a run ends. The page keeps one polite live region, the run's
 * own state line, so a reader is told how the run ended once and is not read each streamed token.
 */

import * as Predicate from "effect/Predicate";
import { Scene } from "foldkit/test";
import { expect, test } from "vitest";
import type { AgentEvent } from "../../../src/page/client/events.js";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { FollowTranscript } from "../../../src/page/client/mount.js";
import { init, update } from "../../../src/page/client/update.js";
import { view } from "../../../src/page/client/view.js";

type Rendered = NonNullable<ReturnType<typeof view>>;

const PROJECT = { id: "repo", displayName: "hello-world", isHarness: false, location: "o/r" };

function after(start: Model, messages: readonly Message[]): Model {
  return messages.reduce((model, message) => update(model, message).model, start);
}

function runWithEvents(events: readonly AgentEvent[]): Model {
  const listed = after(init().model, [Message.SucceededFetchProjects({ projects: [PROJECT] })]);
  const streamId = listed.eventsStreamId;

  const opening: readonly AgentEvent[] = [
    { type: "snapshot", entries: [], tools: [], inbox: [] },
    { type: "run_start", inputs: [1] },
  ];

  return after(
    listed,
    [...opening, ...events].map((event) => Message.ReceivedEvent({ streamId, event })),
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

test("the run's ending is the one polite announcement", () => {
  const ended = runWithEvents([
    { type: "run_end", inputs: [1] },
    { type: "submission", record: { id: 1, status: "done" } },
  ]);

  expect(announced(ended)).toEqual([{ politeness: "polite", text: "answered" }]);
});

test("streamed text does not change what the live region holds", () => {
  const running = announced(runWithEvents([]));

  const streaming = announced(
    runWithEvents([
      {
        type: "message_start",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "" }],
          stopReason: "pending",
        },
      },
      {
        type: "message_update",
        changes: [{ type: "text_delta", contentIndex: 0, delta: "first" }],
      },
      {
        type: "message_update",
        changes: [{ type: "text_delta", contentIndex: 0, delta: " second" }],
      },
    ]),
  );

  expect(streaming).toEqual(running);
  expect(streaming).toEqual([{ politeness: "polite", text: "running" }]);
});
