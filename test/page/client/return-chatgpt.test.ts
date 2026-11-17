import * as Option from "effect/Option";
import { expect, test } from "vitest";
import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import { chatGPTWording, pendingLogin } from "../../../src/page/client/chatgpt.js";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { update } from "../../../src/page/client/update.js";
import { findById, htmlOf } from "./rendered.js";
import { settled } from "./requests.js";
import { answering, BEFORE, LOGIN, loadedWith } from "./server-answers.js";

function after(start: Model, messages: readonly Message[]): Model {
  return messages.reduce((model, message) => update(model, message).model, start);
}

const confirmShown = (model: Model): boolean =>
  findById(htmlOf(model), ID.chatgptDisconnectConfirmButton) !== undefined;

const SIGNING_IN = async (): Promise<Model> =>
  after(await loadedWith({ ...BEFORE, chatgpt: "signing-in" }), [
    Message.UpdatedChatGPTCallbackInput({ value: "http://127.0.0.1:1455/cb?code=c" }),
  ]);

test("returning to the page keeps the callback address the owner is typing", async () => {
  const typing = await SIGNING_IN();

  const done = await settled(
    update(typing, Message.ReturnedToPage()),
    answering({ ...BEFORE, chatgpt: "signing-in" }),
  );

  expect(pendingLogin(done.model.chatgpt)).toEqual(
    Option.some({
      attemptId: LOGIN.attemptId,
      authorizeUrl: LOGIN.authorizeUrl,
      address: "http://127.0.0.1:1455/cb?code=c",
    }),
  );
});

test("returning to the page keeps an open sign-out confirmation while ChatGPT is still connected, and closes it once it is not", async () => {
  const connected = await loadedWith(BEFORE);
  const asked = update(connected, Message.ClickedChatGPTDisconnect()).model;

  expect(confirmShown(asked)).toBe(true);

  const still = await settled(update(asked, Message.ReturnedToPage()), answering(BEFORE));

  expect(chatGPTWording(still.model.chatgpt)).toBe("connected (gpt-6.1-sol)");
  expect(confirmShown(still.model)).toBe(true);

  const signedOut = await settled(
    update(asked, Message.ReturnedToPage()),
    answering({ ...BEFORE, chatgpt: "signing-in" }),
  );

  expect(confirmShown(signedOut.model)).toBe(false);
});
