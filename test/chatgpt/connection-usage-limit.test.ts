import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import * as Effect from "effect/Effect";
import { type ChatGPTConnection, chatgptTurn } from "../../src/chatgpt/index.js";
import {
  ACCESS_ONE,
  ACCESS_TWO,
  CLIENT_ID,
  heldReply,
  REFRESH_ONE,
  REFRESH_TWO,
} from "./fixtures.js";
import { access, connected, HOUR, storeGrant, withConnection } from "./connection-harness.js";
import { AccountEvent } from "../../src/chatgpt/account.js";

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

test("a usage limit reported without a reset time keeps the reset time already known", async () => {
  await withConnection("chatgpt-limit-known-end", noTokenServer, async (harness) => {
    connected(harness);
    const { connection, clock } = harness;
    const reachedAt = clock.now;
    const limitedUntil = reachedAt + HOUR;

    connection.markUsageLimited(ACCESS_ONE, limitedUntil);
    clock.now += 60_000;
    connection.markUsageLimited(ACCESS_ONE, null);

    expect(connection.view().connection).toMatchObject({
      usageLimit: { reachedAt, limitedUntil },
    });
    await expect(access(connection)).resolves.toEqual({ kind: "usage-limited", limitedUntil });
  });
});

test("a new sign-in forgets a usage limit", async () => {
  await withConnection("chatgpt-limit-forgotten", noTokenServer, (harness) => {
    connected(harness);
    const { connection, clock } = harness;

    connection.markUsageLimited(ACCESS_ONE, clock.now + HOUR);
    connected(harness);
    expect(connection.view().connection).not.toHaveProperty("usageLimit");

    return Promise.resolve();
  });
});

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
    store.update(
      AccountEvent.LoggedIn({
        grant: {
          accessToken: ACCESS_TWO,
          refreshToken: REFRESH_TWO,
          expiresAt: clock.now + HOUR,
          clientId: CLIENT_ID,
        },
      }),
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
    storeGrant(state.storage, {
      accessToken: ACCESS_ONE,
      refreshToken: REFRESH_ONE,
      expiresAt: Date.now() + HOUR,
      clientId: CLIENT_ID,
    });
  });

  await supervisor.markChatGPTUsageLimited(ACCESS_ONE, Number.NaN);

  await expect(supervisor.getChatGPTConnection()).resolves.toMatchObject({
    connection: { state: "connected", usageLimit: { limitedUntil: null } },
  });

  await supervisor.markChatGPTUsageLimited(ACCESS_ONE, limitedUntil);

  await expect(supervisor.getChatGPTConnection()).resolves.toMatchObject({
    connection: { state: "connected", usageLimit: { limitedUntil } },
  });
  await expect(supervisor.chatgptAccess()).resolves.toEqual({
    kind: "usage-limited",
    limitedUntil,
  });
});
