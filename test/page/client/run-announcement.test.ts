import * as Predicate from "effect/Predicate";
import { expect, test } from "vitest";
import type { Conversation } from "../../../src/page/client/conversation.js";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { init, update } from "../../../src/page/client/update.js";
import { htmlOf, textOf, type Rendered } from "./rendered.js";
import { received, running, streaming as streamingText, viewing } from "./views.js";

const PROJECT = { id: "repo", displayName: "hello-world", isHarness: false, location: "o/r" };

function after(start: Model, messages: readonly Message[]): Model {
  return messages.reduce((model, message) => update(model, message).model, start);
}

function runWith(conversation: Conversation): Model {
  const listed = after(init().model, [Message.SucceededFetchProjects({ projects: [PROJECT] })]);

  return after(listed, [received(listed, conversation)]);
}

function liveRegions(node: Rendered | string): readonly Rendered[] {
  if (Predicate.isString(node)) {
    return [];
  }

  const isLive = node.data?.attrs?.["aria-live"] !== undefined;

  return [...(isLive ? [node] : []), ...(node.children ?? []).flatMap(liveRegions)];
}

function announced(model: Model): readonly Readonly<{ politeness: unknown; text: string }>[] {
  return liveRegions(htmlOf(model)).map((region) => ({
    politeness: region.data?.attrs?.["aria-live"],
    text: textOf(region),
  }));
}

test("the run's ending is the one polite announcement", () => {
  const busy = runWith(running());
  const ended = after(busy, [received(busy, viewing())]);

  expect(announced(ended)).toEqual([{ politeness: "polite", text: "answered" }]);
});

test("streamed text does not change what the live region holds", () => {
  const waiting = announced(runWith(running()));

  const streaming = announced(runWith(running({ maybePartial: streamingText("first second") })));

  expect(streaming).toEqual(waiting);
  expect(streaming).toEqual([{ politeness: "polite", text: "running" }]);
});
