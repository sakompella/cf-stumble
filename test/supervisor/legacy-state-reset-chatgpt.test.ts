/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { ChatGPTCredentialStore } from "../../src/chatgpt/index.js";
import { capturedEvents, named } from "../log-capture.js";

/**
 * The one-time legacy reset (`legacy-state-reset.ts`) drops every table except the ones it keeps,
 * but only on a Supervisor without its marker. The ChatGPT tables are created after the reset has
 * run, so the marker is what protects the owner's cached credential across a restart.
 */

const RESET_EVENT = "supervisor.legacy-state-reset";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

test("keeps the ChatGPT credential on a Supervisor that already has its marker", async () => {
  const control = env.SUPERVISOR.getByName("legacy-state-reset-chatgpt");

  const grant = {
    accessToken: "chatgpt-access-FAKE-kept",
    refreshToken: "chatgpt-refresh-FAKE-kept",
    expiresAt: 2,
    clientId: "oaiapp_FAKE",
  };

  await runInDurableObject(control, (_instance, state) => {
    new ChatGPTCredentialStore(state.storage).connect(grant, 1);
  });
  await evictDurableObject(control);
  const events = capturedEvents();

  await expect(control.getGenerations()).resolves.toEqual([]);

  const kept = await runInDurableObject(control, (_instance, state) =>
    new ChatGPTCredentialStore(state.storage).connection(),
  );

  expect(kept).toEqual({ state: "connected", ...grant });
  expect(named(events(), RESET_EVENT)).toEqual([]);
});
