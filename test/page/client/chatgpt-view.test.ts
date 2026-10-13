/**
 * What the sidebar offers for each state of the ChatGPT connection, read from the rendered tree.
 */

import * as Predicate from "effect/Predicate";
import { Scene } from "foldkit/test";
import { expect, test } from "vitest";
import { chatGPTConnection } from "../../../src/page/client/api.js";
import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import { Message } from "../../../src/page/client/message.js";
import { FollowTranscript } from "../../../src/page/client/mount.js";
import type { ChatGPTConnection } from "../../../src/page/client/model.js";
import { init, update } from "../../../src/page/client/update.js";
import { view } from "../../../src/page/client/view.js";

const LOGIN = { attemptId: "attempt-1", authorizeUrl: "https://auth.example/authorize?state=s" };

const DISCONNECTED = chatGPTConnection({
  connection: { state: "disconnected" },
  login: null,
  model: "gpt-6.1-sol",
});

const SIGNING_IN = chatGPTConnection({
  connection: { state: "disconnected" },
  login: LOGIN,
  model: "gpt-6.1-sol",
});

const CONNECTED = chatGPTConnection({
  connection: { state: "connected", expiresAt: 1 },
  login: null,
  model: "gpt-6.1-sol",
});

type Rendered = NonNullable<ReturnType<typeof view>>;

function findById(node: Rendered | string, id: string): Rendered | undefined {
  if (Predicate.isString(node)) {
    return undefined;
  }

  return node.data?.props?.["id"] === id
    ? node
    : (node.children ?? []).map((child) => findById(child, id)).find(Predicate.isNotUndefined);
}

function rendered(chatgpt: ChatGPTConnection): (id: string) => Rendered | undefined {
  let html: Rendered | undefined;

  Scene.scene(
    { update, view },
    Scene.given({ ...init().model, chatgpt }),
    Scene.tap((simulation) => {
      html = simulation.html;
    }),
    Scene.Mount.resolve(FollowTranscript, Message.CompletedFollowTranscript()),
  );

  return (id) => (html === undefined ? undefined : findById(html, id));
}

test("the sign-in link opens in its own tab without an opener or a referrer", () => {
  const link = rendered(SIGNING_IN)(ID.chatgptSignInLink);

  expect(link?.data?.props).toMatchObject({
    href: LOGIN.authorizeUrl,
    target: "_blank",
    rel: "noreferrer noopener",
  });
});

test("the sidebar offers one way forward for each state", () => {
  const controls = {
    connect: ID.chatgptConnectButton,
    link: ID.chatgptSignInLink,
    input: ID.chatgptCallbackInput,
    finish: ID.chatgptFinishButton,
    disconnect: ID.chatgptDisconnectButton,
  };

  const offered = (chatgpt: ChatGPTConnection) => {
    const find = rendered(chatgpt);

    return Object.entries(controls)
      .filter(([, id]) => find(id) !== undefined)
      .map(([name]) => name);
  };

  expect(offered(DISCONNECTED)).toEqual(["connect"]);
  expect(offered(SIGNING_IN)).toEqual(["connect", "link", "input", "finish"]);
  expect(offered(CONNECTED)).toEqual(["disconnect"]);
});
