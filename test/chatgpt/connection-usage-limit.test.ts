/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { ChatGPTCredentialStore } from "../../src/chatgpt/index.js";
import { ACCESS_ONE, CLIENT_ID, REFRESH_ONE } from "./fixtures.js";
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

    connection.markUsageLimited(limitedUntil);

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

    connection.markUsageLimited(null);

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

    connection.markUsageLimited(clock.now + HOUR);
    connected(harness);
    expect(connection.view().connection).not.toHaveProperty("usageLimit");

    connection.markUsageLimited(clock.now + HOUR);
    connection.disconnect();
    connected(harness);
    expect(connection.view().connection).not.toHaveProperty("usageLimit");

    return Promise.resolve();
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

  await supervisor.markChatGPTUsageLimited(limitedUntil);

  await expect(supervisor.getChatGPTConnection()).resolves.toMatchObject({
    connection: { state: "connected", usageLimit: { limitedUntil } },
  });
  await expect(supervisor.chatgptAccess()).resolves.toEqual({
    kind: "usage-limited",
    limitedUntil,
  });

  await supervisor.markChatGPTUsageLimited("not a time");

  await expect(supervisor.getChatGPTConnection()).resolves.toMatchObject({
    connection: { state: "connected", usageLimit: { limitedUntil: null } },
  });
});
