import * as Option from "effect/Option";
import { expect, test } from "vitest";
import { codexLoginConnection } from "../../../src/page/client/api.js";
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

function succeeded(codexLogin: ReturnType<typeof viewOf>): Message {
  return Message.SucceededCodexLogin({ codexLogin: codexLoginConnection(codexLogin) });
}

const SIGNING_IN = after(init().model, [succeeded(viewOf(DISCONNECTED, LOGIN))]);

test("only a connected state counts as connected, so only it offers disconnecting", () => {
  const cases: readonly (readonly [Fields, boolean])[] = [
    [DISCONNECTED, false],
    [{ state: "connected", expiresAt: 1 }, true],
    [{ state: "needs-reconnect", reason: "refresh-refused" }, false],
  ];

  for (const [connection, isConnected] of cases) {
    expect(codexLoginConnection(viewOf(connection)).isConnected).toBe(isConnected);
  }
});

test("a view the page cannot word reads as unknown and holds no login", () => {
  for (const unreadable of [null, "text", {}, viewOf({ state: "paused" }, LOGIN), viewOf(null)]) {
    expect(codexLoginConnection(unreadable)).toEqual({
      connection: "unknown",
      isConnected: false,
      maybeLogin: Option.none(),
    });
  }
});

test("a login needs both its attempt and its link", () => {
  expect(codexLoginConnection(viewOf(DISCONNECTED, LOGIN)).maybeLogin).toEqual(Option.some(LOGIN));
  expect(codexLoginConnection(viewOf(DISCONNECTED, { attemptId: "a" })).maybeLogin).toEqual(
    Option.none(),
  );
});

test("finishing sends the login's attempt and the trimmed address", () => {
  const typed = after(SIGNING_IN, [
    Message.UpdatedCodexLoginCallbackInput({ value: "  http://127.0.0.1:1455/cb?code=c  " }),
  ]);

  const finished = update(typed, Message.ClickedCodexLoginFinish());

  expect(finished.model.codexLoginResult).toBe("asking Codex");
  expect(finished.commands).toMatchObject([
    {
      name: "FinishCodexLogin",
      args: { attemptId: "attempt-1", callbackUrl: "http://127.0.0.1:1455/cb?code=c" },
    },
  ]);
});

test("finishing with nothing pasted asks for it and sends nothing", () => {
  const blank = after(SIGNING_IN, [Message.UpdatedCodexLoginCallbackInput({ value: "   " })]);
  const finished = update(blank, Message.ClickedCodexLoginFinish());

  expect(finished.model.codexLoginResult).toBe("paste the address first");
  expect(finished.commands ?? []).toEqual([]);
});

test("a refused finish keeps the login and the address so the owner can correct it", () => {
  const typed = after(SIGNING_IN, [Message.UpdatedCodexLoginCallbackInput({ value: "wrong" })]);

  const refused = update(
    typed,
    Message.RejectedCodexLogin({
      wording: "rejected: wrong-sign-in",
      maybeCodexLogin: Option.some(codexLoginConnection(viewOf(DISCONNECTED, LOGIN))),
    }),
  ).model;

  expect(refused.codexLoginResult).toBe("rejected: wrong-sign-in");
  expect(refused.codexLoginCallbackInput).toBe("wrong");
  expect(refused.codexLogin.maybeLogin).toEqual(Option.some(LOGIN));
});

test("a refusal that ends the login drops the address", () => {
  const typed = after(SIGNING_IN, [Message.UpdatedCodexLoginCallbackInput({ value: "late" })]);

  const expired = update(
    typed,
    Message.RejectedCodexLogin({
      wording: "rejected: expired",
      maybeCodexLogin: Option.some(codexLoginConnection(viewOf(DISCONNECTED))),
    }),
  ).model;

  expect(expired.codexLoginCallbackInput).toBe("");
  expect(Option.isNone(expired.codexLogin.maybeLogin)).toBe(true);
});

test("a connection answer replaces what the page showed and clears the request wording", () => {
  const typed = after(SIGNING_IN, [
    Message.UpdatedCodexLoginCallbackInput({ value: "http://127.0.0.1:1455/cb?code=c" }),
    Message.ClickedCodexLoginFinish(),
  ]);

  const connected = update(typed, succeeded(viewOf({ state: "connected", expiresAt: 1 }))).model;

  expect(connected).toMatchObject({
    codexLogin: { connection: "connected (gpt-6.1-sol)", isConnected: true },
    codexLoginCallbackInput: "",
    codexLoginResult: "",
  });
});

test("connecting and disconnecting each ask the Worker once", () => {
  const connecting = update(init().model, Message.ClickedCodexLogin());
  const disconnecting = update(init().model, Message.ClickedCodexLoginDisconnect());

  expect((connecting.commands ?? []).map((command) => command.name)).toEqual(["StartCodexLogin"]);
  expect((disconnecting.commands ?? []).map((command) => command.name)).toEqual([
    "DisconnectCodexLogin",
  ]);
});

test("an unreachable Worker is reported in the banner and the result", () => {
  const failed = update(init().model, Message.FailedCodexLogin({ detail: "offline" })).model;

  expect(failed.codexLoginResult).toBe("request failed");
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
  expect(codexLoginConnection(limited(Date.UTC(2026, 9, 16, 9, 30)))).toMatchObject({
    connection: "connected (gpt-6.1-sol); usage limit reached until 2026-10-16 09:30 UTC",
    isConnected: true,
  });
  expect(codexLoginConnection(limited(null))).toMatchObject({
    connection: "connected (gpt-6.1-sol); usage limit reached",
    isConnected: true,
  });
});

function commandsAfterRun(start: Model): readonly string[] {
  const busy = update(start, received(start, running())).model;

  return (update(busy, received(busy, viewing())).commands ?? []).map((command) => command.name);
}

test("a run that ends while Codex is connected reads the connection again", () => {
  const connected = after(init().model, [succeeded(viewOf({ state: "connected", expiresAt: 1 }))]);

  expect(commandsAfterRun(connected)).toEqual(["FetchCodexLogin"]);
  expect(commandsAfterRun(init().model)).toEqual([]);
});
