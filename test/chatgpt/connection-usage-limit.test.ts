/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import * as Effect from "effect/Effect";
import {
  type ChatGPTConnection,
  ChatGPTCredentialStore,
  chatgptTurn,
} from "../../src/chatgpt/index.js";
import {
  ACCESS_ONE,
  ACCESS_TWO,
  CLIENT_ID,
  heldReply,
  REFRESH_ONE,
  REFRESH_TWO,
} from "./fixtures.js";
import { access, connected, HOUR, withConnection } from "./connection-harness.js";

/** A ChatGPT usage limit: it keeps the connection, and the owner's view says it was reached. */

afterEach(async () => {
  await reset();
});

const noTokenServer = () => Promise.reject(new Error("no refresh is expected"));

test("a usage limit with a reset time skips ChatGPT until then, and the view says so", async () => {
  await withConnection("chatgpt-limit-until", noTokenServer, async (harness) => {
    connected(harness);
    const { connection, clock } = harness;
    const reachedAt = clock.now;
    const limitedUntil = reachedAt + 60_000;

    connection.markUsageLimited(ACCESS_ONE, limitedUntil);

    expect(connection.view().connection).toEqual({
      state: "connected",
      expiresAt: reachedAt + HOUR,
      usageLimit: { reachedAt, limitedUntil },
    });
    await expect(access(connection)).resolves.toEqual({ kind: "usage-limited", limitedUntil });

    clock.now = limitedUntil;

    expect(connection.view().connection).not.toHaveProperty("usageLimit");
    await expect(access(connection)).resolves.toEqual({ kind: "ready", accessToken: ACCESS_ONE });
  });
});

test("a usage limit without a reset time shows until ChatGPT is asked again", async () => {
  await withConnection("chatgpt-limit-unknown", noTokenServer, async (harness) => {
    connected(harness);
    const { connection, clock } = harness;

    connection.markUsageLimited(ACCESS_ONE, null);

    expect(connection.view().connection).toMatchObject({
      state: "connected",
      usageLimit: { reachedAt: clock.now, limitedUntil: null },
    });
    await expect(access(connection)).resolves.toEqual({ kind: "ready", accessToken: ACCESS_ONE });
    expect(connection.view().connection).not.toHaveProperty("usageLimit");
  });
});

test("a new sign-in and a disconnect forget a usage limit", async () => {
  await withConnection("chatgpt-limit-forgotten", noTokenServer, (harness) => {
    connected(harness);
    const { connection, clock } = harness;

    connection.markUsageLimited(ACCESS_ONE, clock.now + HOUR);
    connected(harness);
    expect(connection.view().connection).not.toHaveProperty("usageLimit");

    connection.markUsageLimited(ACCESS_ONE, clock.now + HOUR);
    connection.disconnect();
    connected(harness);
    expect(connection.view().connection).not.toHaveProperty("usageLimit");

    return Promise.resolve();
  });
});

/** A ChatGPT call over `connection` whose provider answers only when the test releases it. */
function heldCall(connection: ChatGPTConnection) {
  const provider = heldReply();
  let markSent: (() => void) | undefined;

  const sent = new Promise<void>((resolve) => {
    markSent = resolve;
  });

  const outcome = Effect.runPromise(
    chatgptTurn(
      {
        credential: {
          access: (rejected) => access(connection, rejected),
          markRefused: () => Promise.reject(new Error("no refusal is expected")),
          markUsageLimited: (token, limitedUntil) => {
            connection.markUsageLimited(token, limitedUntil);

            return Promise.resolve();
          },
        },
        fetcher: () => {
          markSent?.();

          return provider.reply;
        },
        model: "gpt-test",
      },
      { messages: [{ role: "user", content: "hi" }] },
    )(() => {}).pipe(
      Effect.as("answered"),
      Effect.catchTag("ChatGPTUsageLimited", () => Effect.succeed("usage-limited")),
    ),
  );

  return { sent, release: provider.release, outcome };
}

test("a usage limit an old call meets after a new sign-in does not pause the new account", async () => {
  await withConnection("chatgpt-limit-stale", noTokenServer, async (harness) => {
    connected(harness);
    const { connection, store, clock } = harness;
    const call = heldCall(connection);

    await call.sent;
    connection.disconnect();
    store.connect(
      {
        accessToken: ACCESS_TWO,
        refreshToken: REFRESH_TWO,
        expiresAt: clock.now + HOUR,
        clientId: CLIENT_ID,
      },
      clock.now,
    );
    call.release(
      Response.json(
        { error: { code: "subscription_sharing_usage_limit_exceeded" } },
        { status: 429, headers: { "retry-after": "3600" } },
      ),
    );

    await expect(call.outcome).resolves.toBe("usage-limited");
    expect(connection.view().connection).not.toHaveProperty("usageLimit");
    await expect(access(connection)).resolves.toEqual({ kind: "ready", accessToken: ACCESS_TWO });
  });
});

test("the Supervisor records a usage limit the route reports and shows it in the owner's view", async () => {
  const supervisor = env.SUPERVISOR.getByName("chatgpt-limit-rpc");
  const limitedUntil = Date.now() + HOUR;

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

  await supervisor.markChatGPTUsageLimited(ACCESS_ONE, limitedUntil);

  await expect(supervisor.getChatGPTConnection()).resolves.toMatchObject({
    connection: { state: "connected", usageLimit: { limitedUntil } },
  });
  await expect(supervisor.chatgptAccess()).resolves.toEqual({
    kind: "usage-limited",
    limitedUntil,
  });

  await supervisor.markChatGPTUsageLimited(ACCESS_ONE, "not a time");

  await expect(supervisor.getChatGPTConnection()).resolves.toMatchObject({
    connection: { state: "connected", usageLimit: { limitedUntil: null } },
  });
});
