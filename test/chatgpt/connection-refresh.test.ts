/// <reference types="@cloudflare/vitest-plugin/types" />

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

/** Refreshing the cached credential: one refresh for concurrent callers, rotated tokens stored
 * atomically, and refusals that need a reconnect. */

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

      expect(harness.store.connection()).toEqual({
        state: "connected",
        accessToken: ACCESS_TWO,
        refreshToken: REFRESH_TWO,
        expiresAt: harness.clock.now + HOUR,
        clientId: CLIENT_ID,
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
    (_instance, state) => new ChatGPTCredentialStore(state.storage).connection(),
  );

  expect(rotated).toMatchObject({ refreshToken: REFRESH_TWO });
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
      const before = harness.store.connection();

      await expect(access(harness.connection)).resolves.toEqual({
        kind: "ready",
        accessToken: ACCESS_ONE,
      });
      await expect(access(harness.connection, ACCESS_ONE)).resolves.toEqual({
        kind: "unavailable",
      });
      harness.clock.now += 120_000;
      await expect(access(harness.connection)).resolves.toEqual({ kind: "unavailable" });
      expect(harness.store.connection()).toEqual(before);
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

      harness.store.connect(
        {
          accessToken: "chatgpt-access-FAKE-new-sign-in",
          refreshToken: "chatgpt-refresh-FAKE-new-sign-in",
          expiresAt: harness.clock.now + HOUR,
          clientId: CLIENT_ID,
        },
        harness.clock.now,
      );
      held.release(grant(ACCESS_TWO, REFRESH_TWO));

      await expect(refreshing).resolves.toEqual({
        kind: "ready",
        accessToken: "chatgpt-access-FAKE-new-sign-in",
      });
      expect(harness.store.connection()).toMatchObject({
        refreshToken: "chatgpt-refresh-FAKE-new-sign-in",
      });
    },
  );
});
