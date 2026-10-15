/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import * as Effect from "effect/Effect";
import { afterEach, expect, test, vi } from "vitest";
import { type ChatGPTConnection, ChatGPTCredentialStore } from "../../src/chatgpt/index.js";
import { capturedEvents, everythingLogged, named } from "../log-capture.js";
import {
  ACCESS_ONE,
  ACCESS_TWO,
  challengeOf,
  CLIENT_ID,
  formOf,
  grant,
  heldReply,
  REFRESH_ONE,
  REFRESH_TWO,
} from "./fixtures.js";
import { type Harness, HOUR, withConnection } from "./connection-harness.js";

/** Signing in to ChatGPT, and the Supervisor surface the owner API and the model route use. */

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

test("a sign-in started here and finished with its address connects, and no view carries a token", async () => {
  const logged = capturedEvents();

  await withConnection(
    "chatgpt-sign-in",
    () => Promise.resolve(grant(ACCESS_ONE, REFRESH_ONE)),
    async ({ connection, calls, clock }) => {
      const started = await Effect.runPromise(connection.startLogin());
      const login = started.login;

      if (login === null) throw new Error("a started sign-in must be visible");
      const authorize = new URL(login.authorizeUrl).searchParams;
      const state = authorize.get("state") ?? "";

      const outcome = await Effect.runPromise(
        connection.completeLogin(
          login.attemptId,
          `http://127.0.0.1:1455/auth/callback?code=code-FAKE&state=${state}&client_id=${CLIENT_ID}`,
        ),
      );

      expect(outcome).toEqual({
        ok: true,
        chatgpt: {
          connection: { state: "connected", expiresAt: clock.now + HOUR },
          login: null,
          model: "gpt-test",
        },
      });

      const exchange = formOf(calls[0]);
      expect(exchange.get("grant_type")).toBe("authorization_code");
      expect(exchange.get("client_id")).toBe(CLIENT_ID);
      expect(exchange.get("code")).toBe("code-FAKE");
      expect(exchange.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");

      const verifier = exchange.get("code_verifier") ?? "";
      expect(authorize.get("code_challenge")).toBe(await challengeOf(verifier));

      const again = await Effect.runPromise(
        connection.completeLogin(login.attemptId, "http://127.0.0.1:1455/auth/callback"),
      );

      expect(again).toMatchObject({ ok: false, problem: { code: "no-sign-in" } });

      const views = JSON.stringify([started, outcome, again, connection.view()]);
      expect(views).not.toMatch(/FAKE/u);
      expect(views).not.toContain(verifier);
    },
  );

  expect(named(logged(), "chatgpt.login.complete").map((event) => event.outcome)).toEqual([
    "connected",
    "no-sign-in",
  ]);
  expect(everythingLogged()).not.toMatch(/FAKE/u);
});

test("an address from another sign-in is refused without using up this one, and an old one expires", async () => {
  await withConnection(
    "chatgpt-sign-in-refusals",
    () => Promise.reject(new Error("no exchange may start")),
    async ({ connection, calls, clock }) => {
      const login = (await Effect.runPromise(connection.startLogin())).login;

      if (login === null) throw new Error("a started sign-in must be visible");

      const crossed = await Effect.runPromise(
        connection.completeLogin(
          login.attemptId,
          "http://127.0.0.1:1455/auth/callback?code=c&state=someone-else&client_id=a",
        ),
      );

      expect(crossed).toMatchObject({ ok: false, problem: { code: "wrong-sign-in" } });
      expect(connection.view().login?.attemptId).toBe(login.attemptId);

      clock.now += 10 * 60 * 1000;

      const late = await Effect.runPromise(
        connection.completeLogin(login.attemptId, "http://127.0.0.1:1455/auth/callback"),
      );

      expect(late).toMatchObject({ ok: false, problem: { code: "expired" } });
      expect(connection.view()).toMatchObject({
        connection: { state: "disconnected" },
        login: null,
      });
      expect(calls).toEqual([]);
    },
  );
});

test("the Supervisor reports no credential before the first connection, and a disconnect forgets one", async () => {
  const supervisor = env.SUPERVISOR.getByName("chatgpt-supervisor-rpc");

  await expect(supervisor.chatgptAccess()).resolves.toEqual({ kind: "not-connected" });
  await expect(supervisor.getChatGPTConnection()).resolves.toEqual({
    connection: { state: "disconnected" },
    login: null,
    model: "gpt-6.1-sol",
  });

  await runInDurableObject(supervisor, (_instance, state) => {
    new ChatGPTCredentialStore(state.storage).connect(
      {
        accessToken: ACCESS_ONE,
        refreshToken: REFRESH_ONE,
        expiresAt: Date.now() + HOUR,
        clientId: CLIENT_ID,
      },
      Date.now(),
    );
  });

  await expect(supervisor.chatgptAccess()).resolves.toEqual({
    kind: "ready",
    accessToken: ACCESS_ONE,
  });
  await expect(supervisor.disconnectChatGPT()).resolves.toMatchObject({
    connection: { state: "disconnected" },
  });
  await expect(supervisor.chatgptAccess()).resolves.toEqual({ kind: "not-connected" });
});

/** A token endpoint that holds each exchange until the test releases it, in any order. */
function heldExchanges(count: number) {
  const held = Array.from({ length: count }, () => heldReply());
  let next = 0;

  return {
    held,
    reply: () => held[next++]?.reply ?? Promise.reject(new Error("one exchange too many")),
  };
}

async function requestsMade(harness: Harness, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(harness.calls).toHaveLength(count);
  });
}

/** Start a sign-in and return a function that finishes it with a matching address. */
async function startSignIn(connection: ChatGPTConnection) {
  const login = (await Effect.runPromise(connection.startLogin())).login;

  if (login === null) throw new Error("a started sign-in must be visible");
  const state = new URL(login.authorizeUrl).searchParams.get("state") ?? "";

  return () =>
    Effect.runPromise(
      connection.completeLogin(
        login.attemptId,
        `http://127.0.0.1:1455/auth/callback?code=code-FAKE&state=${state}&client_id=${CLIENT_ID}`,
      ),
    );
}

test("a Disconnect during the code exchange is not undone by its late grant", async () => {
  const exchanges = heldExchanges(1);

  await withConnection("chatgpt-exchange-disconnect", exchanges.reply, async (harness) => {
    const finishing = (await startSignIn(harness.connection))();
    await requestsMade(harness, 1);

    harness.connection.disconnect();
    exchanges.held[0]?.release(grant(ACCESS_ONE, REFRESH_ONE));

    await expect(finishing).resolves.toMatchObject({ ok: false, problem: { code: "no-sign-in" } });
    expect(harness.store.connection()).toBeUndefined();
    expect(harness.connection.view()).toMatchObject({
      connection: { state: "disconnected" },
      login: null,
    });
  });
});

test("a sign-in started during an exchange makes the older grant stale", async () => {
  const exchanges = heldExchanges(2);

  await withConnection("chatgpt-exchange-newer-sign-in", exchanges.reply, async (harness) => {
    const older = (await startSignIn(harness.connection))();
    await requestsMade(harness, 1);
    const finishNewer = await startSignIn(harness.connection);

    exchanges.held[0]?.release(grant(ACCESS_ONE, REFRESH_ONE));

    await expect(older).resolves.toMatchObject({ ok: false, problem: { code: "no-sign-in" } });
    expect(harness.store.connection()).toBeUndefined();

    const newer = finishNewer();
    await requestsMade(harness, 2);
    exchanges.held[1]?.release(grant(ACCESS_TWO, REFRESH_TWO));

    await expect(newer).resolves.toMatchObject({ ok: true });
    expect(harness.store.connection()).toMatchObject({ accessToken: ACCESS_TWO });
  });
});

test("an older exchange that finishes after a newer sign-in does not overwrite it", async () => {
  const exchanges = heldExchanges(2);

  await withConnection("chatgpt-exchange-later-first", exchanges.reply, async (harness) => {
    const older = (await startSignIn(harness.connection))();
    await requestsMade(harness, 1);
    const newer = (await startSignIn(harness.connection))();
    await requestsMade(harness, 2);

    exchanges.held[1]?.release(grant(ACCESS_TWO, REFRESH_TWO));
    await expect(newer).resolves.toMatchObject({ ok: true });

    exchanges.held[0]?.release(grant(ACCESS_ONE, REFRESH_ONE));
    await expect(older).resolves.toMatchObject({ ok: false, problem: { code: "no-sign-in" } });
    expect(harness.store.connection()).toMatchObject({
      accessToken: ACCESS_TWO,
      refreshToken: REFRESH_TWO,
    });
  });
});
