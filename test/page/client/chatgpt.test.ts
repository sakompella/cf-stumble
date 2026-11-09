import * as Option from "effect/Option";
import { expect, test } from "vitest";
import { chatGPTConnection } from "../../../src/page/client/api.js";
import { ChatGPT, chatGPTWording, pendingLogin } from "../../../src/page/client/chatgpt.js";
import { Message } from "../../../src/page/client/message.js";
import type { Model } from "../../../src/page/client/model.js";
import { init, update } from "../../../src/page/client/update.js";
import { received, running, viewing } from "./views.js";

const LOGIN = { attemptId: "attempt-1", authorizeUrl: "https://auth.example/authorize?state=s" };

const DISCONNECTED = { state: "disconnected" };

type Fields = Readonly<Record<string, string | number>>;

function viewOf(connection: Fields | null, login: Fields | null = null) {
  return { connection, login, model: "gpt-6.1-sol" };
}

function after(start: Model, messages: readonly Message[]): Model {
  return messages.reduce((model, message) => update(model, message).model, start);
}

function succeeded(chatgpt: ReturnType<typeof viewOf>): Message {
  return Message.SucceededChatGPT({ chatgpt: chatGPTConnection(chatgpt) });
}

const SIGNING_IN = after(init().model, [succeeded(viewOf(DISCONNECTED, LOGIN))]);

test("only a connected state counts as connected, so only it offers disconnecting", () => {
  const cases: readonly (readonly [Fields, boolean])[] = [
    [DISCONNECTED, false],
    [{ state: "connected", expiresAt: 1 }, true],
    [{ state: "needs-reconnect", reason: "refresh-refused" }, false],
  ];

  for (const [connection, isConnected] of cases) {
    expect(ChatGPT.guards.Connected(chatGPTConnection(viewOf(connection)))).toBe(isConnected);
  }
});

test("a view the page cannot word reads as unknown", () => {
  for (const unreadable of [null, "text", {}, viewOf({ state: "paused" }, LOGIN), viewOf(null)]) {
    expect(chatGPTConnection(unreadable)).toEqual(ChatGPT.Unknown());
  }
});

test("a login needs both its attempt and its link", () => {
  expect(pendingLogin(chatGPTConnection(viewOf(DISCONNECTED, LOGIN)))).toEqual(
    Option.some({ ...LOGIN, address: "" }),
  );
  expect(pendingLogin(chatGPTConnection(viewOf(DISCONNECTED, { attemptId: "a" })))).toEqual(
    Option.none(),
  );
});

test("finishing sends the login's attempt and the trimmed address", () => {
  const typed = after(SIGNING_IN, [
    Message.UpdatedChatGPTCallbackInput({ value: "  http://127.0.0.1:1455/cb?code=c  " }),
  ]);

  const finished = update(typed, Message.ClickedChatGPTFinish());

  expect(finished.model.chatgptResult).toBe("asking ChatGPT");
  expect(finished.commands).toMatchObject([
    {
      name: "FinishChatGPTLogin",
      args: { attemptId: "attempt-1", callbackUrl: "http://127.0.0.1:1455/cb?code=c" },
    },
  ]);
});

test("finishing with nothing pasted asks for it and sends nothing", () => {
  const blank = after(SIGNING_IN, [Message.UpdatedChatGPTCallbackInput({ value: "   " })]);
  const finished = update(blank, Message.ClickedChatGPTFinish());

  expect(finished.model.chatgptResult).toBe("paste the address first");
  expect(finished.commands ?? []).toEqual([]);
});

test("a refused finish keeps the login and the address so the owner can correct it", () => {
  const typed = after(SIGNING_IN, [Message.UpdatedChatGPTCallbackInput({ value: "wrong" })]);

  const refused = update(
    typed,
    Message.RejectedChatGPT({
      wording: "rejected: wrong-sign-in",
      maybeChatGPT: Option.some(chatGPTConnection(viewOf(DISCONNECTED, LOGIN))),
    }),
  ).model;

  expect(refused.chatgptResult).toBe("rejected: wrong-sign-in");
  expect(pendingLogin(refused.chatgpt)).toEqual(Option.some({ ...LOGIN, address: "wrong" }));
});

test("a refusal that ends the login drops the address", () => {
  const typed = after(SIGNING_IN, [Message.UpdatedChatGPTCallbackInput({ value: "late" })]);

  const expired = update(
    typed,
    Message.RejectedChatGPT({
      wording: "rejected: expired",
      maybeChatGPT: Option.some(chatGPTConnection(viewOf(DISCONNECTED))),
    }),
  ).model;

  expect(Option.isNone(pendingLogin(expired.chatgpt))).toBe(true);
});

test("a connection answer replaces what the page showed and clears the request wording", () => {
  const typed = after(SIGNING_IN, [
    Message.UpdatedChatGPTCallbackInput({ value: "http://127.0.0.1:1455/cb?code=c" }),
    Message.ClickedChatGPTFinish(),
  ]);

  const connected = update(typed, succeeded(viewOf({ state: "connected", expiresAt: 1 }))).model;

  expect(chatGPTWording(connected.chatgpt)).toBe("connected (gpt-6.1-sol)");
  expect(connected.chatgptResult).toBe("");
});

test("connecting and disconnecting each ask the Worker once", () => {
  const connecting = update(init().model, Message.ClickedChatGPTLogin());
  const disconnecting = update(init().model, Message.ClickedChatGPTDisconnect());

  expect((connecting.commands ?? []).map((command) => command.name)).toEqual(["StartChatGPTLogin"]);
  expect((disconnecting.commands ?? []).map((command) => command.name)).toEqual([
    "DisconnectChatGPT",
  ]);
});

test("an unreachable Worker is reported in the banner and the result", () => {
  const failed = update(init().model, Message.FailedChatGPT({ detail: "offline" })).model;

  expect(failed.chatgptResult).toBe("request failed");
  expect(failed.pageError).toContain("offline");
});

function limited(limitedUntil: number | null) {
  return {
    connection: { state: "connected", expiresAt: 1, usageLimit: { reachedAt: 1, limitedUntil } },
    login: null,
    model: "gpt-6.1-sol",
  };
}

test("a usage limit is worded with its end when OpenAI named one, and the connection stays", () => {
  const until = chatGPTConnection(limited(Date.UTC(2026, 9, 16, 9, 30)));
  const unnamed = chatGPTConnection(limited(null));

  expect(chatGPTWording(until)).toBe(
    "connected (gpt-6.1-sol); usage limit reached until 2026-10-16 09:30 UTC",
  );
  expect(chatGPTWording(unnamed)).toBe("connected (gpt-6.1-sol); usage limit reached");
  expect([until, unnamed].map((chatgpt) => ChatGPT.guards.Connected(chatgpt))).toEqual([
    true,
    true,
  ]);
});

function commandsAfterRun(start: Model): readonly string[] {
  const busy = update(start, received(start, running())).model;

  return (update(busy, received(busy, viewing())).commands ?? []).map((command) => command.name);
}

test("a run that ends while ChatGPT is connected reads the connection again", () => {
  const connected = after(init().model, [succeeded(viewOf({ state: "connected", expiresAt: 1 }))]);

  expect(commandsAfterRun(connected)).toEqual(["FetchChatGPT"]);
  expect(commandsAfterRun(init().model)).toEqual([]);
});
