import { expect, test } from "vitest";
import { chatGPTConnection } from "../../../src/page/client/chatgpt.js";
import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import type { ChatGPT } from "../../../src/page/client/chatgpt.js";
import { init } from "../../../src/page/client/update.js";
import { findById, htmlOf, type Rendered } from "./rendered.js";

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

function rendered(chatgpt: ChatGPT): (id: string) => Rendered | undefined {
  const html = htmlOf({ ...init().model, chatgpt });

  return (id) => findById(html, id);
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

  const offered = (chatgpt: ChatGPT) => {
    const find = rendered(chatgpt);

    return Object.entries(controls)
      .filter(([, id]) => find(id) !== undefined)
      .map(([name]) => name);
  };

  expect(offered(DISCONNECTED)).toEqual(["connect"]);
  expect(offered(SIGNING_IN)).toEqual(["connect", "link", "input", "finish"]);
  expect(offered(CONNECTED)).toEqual(["disconnect"]);
});
