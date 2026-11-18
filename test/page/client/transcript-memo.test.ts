import type { HtmlBuilder } from "foldkit/html";
import * as Option from "effect/Option";
import { Lazy } from "foldkit/test";
import { expect, test } from "vitest";
import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import type { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { transcriptOf } from "../../../src/page/client/transcript.js";
import { transcriptView } from "../../../src/page/client/view-transcript.js";
import { renderingEach, streamed } from "./memo-fixtures.js";

function transcriptOfModel(model: Model, h: HtmlBuilder<Message>) {
  return transcriptView(
    transcriptOf(
      model.conversation,
      model.outgoing,
      Option.getOrElse(model.maybeProjectId, () => ""),
    ),
    ID.messageList,
    h,
  );
}

function rebuildTranscript(firstText: string, secondText: string) {
  Lazy.expectAllReused({
    view: renderingEach(streamed(firstText), streamed(secondText), transcriptOfModel),
    model: null,
  });
}

test("streaming a reply rebuilds only the row that changed", () => {
  expect(() => {
    rebuildTranscript("Hel", "Hello");
  }).toThrow(/^1 lazy cache miss /u);
});

test("a transcript rebuilt from equal values reuses every row", () => {
  rebuildTranscript("Hel", "Hel");
});
