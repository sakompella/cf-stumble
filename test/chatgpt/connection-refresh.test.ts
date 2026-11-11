import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { ChatGPTCredentialStore } from "../../src/chatgpt/index.js";
import { capturedEvents, everythingLogged, named } from "../log-capture.js";
import {
  ACCESS_ONE,
  ACCESS_TWO,
  CLIENT_ID,
  formOf,
  grant,
  heldReply,
  REFRESH_ONE,
  REFRESH_TWO,
} from "./fixtures.js";
import { access, connected, HOUR, withConnection } from "./connection-harness.js";
import { AccountEvent } from "../../src/chatgpt/account.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

test("concurrent callers near expiry share one refresh, and the rotated pair is stored", async () => {
  const held = heldReply();

  await withConnection(
    "chatgpt-refresh-race",
    () => held.reply,
    async (harness) => {
      connected(harness, 5 * 60 * 1000);

      const first = access(harness.connection);
      const second = access(harness.connection);
      await Promise.resolve();
      held.release(grant(ACCESS_TWO, REFRESH_TWO));

      await expect(Promise.all([first, second])).resolves.toEqual([
        { kind: "ready", accessToken: ACCESS_TWO },
        { kind: "ready", accessToken: ACCESS_TWO },
      ]);
      expect(harness.calls).toHaveLength(1);

      const refresh = formOf(harness.calls[0]);
      expect(refresh.get("grant_type")).toBe("refresh_token");
      expect(refresh.get("client_id")).toBe(CLIENT_ID);
      expect(refresh.get("refresh_token")).toBe(REFRESH_ONE);

      expect(harness.store.account()).toEqual({
        _tag: "connected",
        accessToken: ACCESS_TWO,
        refreshToken: REFRESH_TWO,
        expiresAt: harness.clock.now + HOUR,
        clientId: CLIENT_ID,
        usageLimit: null,
      });
      await expect(access(harness.connection)).resolves.toEqual({
        kind: "ready",
        accessToken: ACCESS_TWO,
      });
      expect(harness.calls).toHaveLength(1);
    },
  );

  const rotated = await runInDurableObject(
    env.SUPERVISOR.getByName("chatgpt-refresh-race"),
    (_instance, state) => new ChatGPTCredentialStore(state.storage).account(),
  );

  expect(rotated).toMatchObject({ refreshToken: REFRESH_TWO });
});

function jwtPart(claims: Readonly<Record<string, string | number>>): string {
  return btoa(JSON.stringify(claims)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function accessJwt(name: string, exp: number): string {
  return `${jwtPart({ alg: "RS256" })}.${jwtPart({ exp, jti: name })}.FAKE-signature`;
}

test("a refresh reply without a scope, a lifetime or a refresh token keeps the latest refresh token", async () => {
  const firstExp = 4600;
  const secondExp = 8200;
  const rotatedAccess = accessJwt("rotated", firstExp);
  const renewedAccess = accessJwt("renewed", secondExp);

  const replies = [
    { access_token: rotatedAccess, refresh_token: REFRESH_TWO },
    { access_token: renewedAccess },
  ];

  await withConnection(
    "chatgpt-refresh-sparse-reply",
    () => Promise.resolve(Response.json(replies.shift())),
    async (harness) => {
      connected(harness, 5 * 60 * 1000);

      await expect(access(harness.connection)).resolves.toEqual({
        kind: "ready",
        accessToken: rotatedAccess,
      });
      expect(harness.store.account()).toMatchObject({
        accessToken: rotatedAccess,
        refreshToken: REFRESH_TWO,
        expiresAt: firstExp * 1000,
      });

      await expect(access(harness.connection, rotatedAccess)).resolves.toEqual({
        kind: "ready",
        accessToken: renewedAccess,
      });
      expect(harness.calls.map((call) => formOf(call).get("refresh_token"))).toEqual([
        REFRESH_ONE,
        REFRESH_TWO,
      ]);
      expect(harness.store.account()).toMatchObject({
        accessToken: renewedAccess,
        refreshToken: REFRESH_TWO,
        expiresAt: secondExp * 1000,
      });
    },
  );
});

test("a token far from expiry is used as stored, and one the provider refused is refreshed", async () => {
  await withConnection(
    "chatgpt-refused-token",
    () => Promise.resolve(grant(ACCESS_TWO, REFRESH_TWO)),
    async (harness) => {
      connected(harness);

      await expect(access(harness.connection)).resolves.toEqual({
        kind: "ready",
        accessToken: ACCESS_ONE,
      });
      expect(harness.calls).toEqual([]);

      await expect(access(harness.connection, ACCESS_ONE)).resolves.toEqual({
        kind: "ready",
        accessToken: ACCESS_TWO,
      });
      await expect(access(harness.connection, ACCESS_ONE)).resolves.toEqual({
        kind: "ready",
        accessToken: ACCESS_TWO,
      });
      expect(harness.calls).toHaveLength(1);
    },
  );
});

test("a refused refresh needs a reconnect, and so does a token refused after one", async () => {
  const logged = capturedEvents();

  await withConnection(
    "chatgpt-refresh-refused",
    () => Promise.resolve(Response.json({ error: "invalid_grant" }, { status: 400 })),
    async (harness) => {
      connected(harness, 60_000);

      await expect(access(harness.connection)).resolves.toEqual({ kind: "reconnect-required" });
      expect(harness.connection.view().connection).toEqual({
        state: "needs-reconnect",
        reason: "refresh-refused",
      });

      connected(harness);
      harness.connection.markRefused(ACCESS_ONE);
      expect(harness.connection.view().connection).toEqual({
        state: "needs-reconnect",
        reason: "provider-refused",
      });
      await expect(access(harness.connection)).resolves.toEqual({ kind: "reconnect-required" });
    },
  );

  expect(named(logged(), "chatgpt.refresh")).toEqual([
    expect.objectContaining({ level: "error", outcome: "rejected" }),
  ]);
  expect(everythingLogged()).not.toMatch(/FAKE/u);
});

test("a busy token server keeps the stored pair and a still-valid token keeps working", async () => {
  await withConnection(
    "chatgpt-refresh-busy",
    () => Promise.resolve(new Response("busy", { status: 503 })),
    async (harness) => {
      connected(harness, 60_000);
      const before = harness.store.account();

      await expect(access(harness.connection)).resolves.toEqual({
        kind: "ready",
        accessToken: ACCESS_ONE,
      });
      await expect(access(harness.connection, ACCESS_ONE)).resolves.toEqual({
        kind: "unavailable",
      });
      harness.clock.now += 120_000;
      await expect(access(harness.connection)).resolves.toEqual({ kind: "unavailable" });
      expect(harness.store.account()).toEqual(before);
    },
  );
});

test("a caller that joins a refresh with the token it rejected does not get that token back", async () => {
  const held = heldReply();

  await withConnection(
    "chatgpt-refresh-joined-rejected",
    () => held.reply,
    async (harness) => {
      connected(harness, 5 * 60 * 1000);

      const starter = access(harness.connection);
      const joiner = access(harness.connection, ACCESS_ONE);
      await Promise.resolve();
      held.release(new Response("busy", { status: 503 }));

      await expect(starter).resolves.toEqual({ kind: "ready", accessToken: ACCESS_ONE });
      await expect(joiner).resolves.toEqual({ kind: "unavailable" });
      expect(harness.calls).toHaveLength(1);
    },
  );
});

test("a sign-in that lands during a refresh wins over the refreshed pair", async () => {
  const held = heldReply();

  await withConnection(
    "chatgpt-refresh-superseded",
    () => held.reply,
    async (harness) => {
      connected(harness, 60_000);
      const refreshing = access(harness.connection);
      await Promise.resolve();

      harness.store.update(
        AccountEvent.LoggedIn({
          grant: {
            accessToken: "chatgpt-access-FAKE-new-sign-in",
            refreshToken: "chatgpt-refresh-FAKE-new-sign-in",
            expiresAt: harness.clock.now + HOUR,
            clientId: CLIENT_ID,
          },
        }),
        harness.clock.now,
      );
      held.release(grant(ACCESS_TWO, REFRESH_TWO));

      await expect(refreshing).resolves.toEqual({
        kind: "ready",
        accessToken: "chatgpt-access-FAKE-new-sign-in",
      });
      expect(harness.store.account()).toMatchObject({
        refreshToken: "chatgpt-refresh-FAKE-new-sign-in",
      });
    },
  );
});

test("a Disconnect while the token server is busy leaves the caller not connected", async () => {
  const held = heldReply();

  await withConnection(
    "chatgpt-refresh-busy-disconnect",
    () => held.reply,
    async (harness) => {
      connected(harness, 60_000);
      const refreshing = access(harness.connection);
      await vi.waitFor(() => {
        expect(harness.calls).toHaveLength(1);
      });

      harness.connection.disconnect();
      held.release(new Response("busy", { status: 503 }));

      await expect(refreshing).resolves.toEqual({ kind: "not-connected" });
    },
  );
});

test("a token the provider refused while the token server was busy is not handed out", async () => {
  const held = heldReply();

  await withConnection(
    "chatgpt-refresh-busy-refused",
    () => held.reply,
    async (harness) => {
      connected(harness, 60_000);
      const refreshing = access(harness.connection);
      await vi.waitFor(() => {
        expect(harness.calls).toHaveLength(1);
      });

      harness.connection.markRefused(ACCESS_ONE);
      held.release(new Response("busy", { status: 503 }));

      await expect(refreshing).resolves.toEqual({ kind: "reconnect-required" });
    },
  );
});

test("an account that replaced the pair while the token server was busy is the one used", async () => {
  const held = heldReply();

  await withConnection(
    "chatgpt-refresh-busy-replaced",
    () => held.reply,
    async (harness) => {
      connected(harness, 60_000);
      const refreshing = access(harness.connection);
      await vi.waitFor(() => {
        expect(harness.calls).toHaveLength(1);
      });

      harness.store.update(
        AccountEvent.LoggedIn({
          grant: {
            accessToken: ACCESS_TWO,
            refreshToken: REFRESH_TWO,
            expiresAt: harness.clock.now + HOUR,
            clientId: CLIENT_ID,
          },
        }),
        harness.clock.now,
      );
      held.release(new Response("busy", { status: 503 }));

      await expect(refreshing).resolves.toEqual({ kind: "ready", accessToken: ACCESS_TWO });
    },
  );
});
