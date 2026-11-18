import { Lazy } from "foldkit/test";
import { test } from "vitest";
import { Message } from "../../../src/page/client/message.js";
import { update } from "../../../src/page/client/update.js";
import { view } from "../../../src/page/client/view.js";
import { renderingEach, withHistory } from "./memo-fixtures.js";

test("editing the prompt reuses the rendered transcript instead of building it again", () => {
  const edited = update(withHistory, Message.UpdatedPrompt({ value: "next question" })).model;

  Lazy.expectAllReused({ view: renderingEach(withHistory, edited, view), model: null });
});
