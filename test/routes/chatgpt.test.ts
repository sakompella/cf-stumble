import { afterEach, expect, test, vi } from "vitest";
import type { ChatGPTConnectionView, ChatGPTLoginOutcome } from "../../src/chatgpt/index.js";
import {
  controlRequest,
  disconnectedChatGPT,
  ownerApiResponse,
  ownerApiSupervisor,
  ownerScope,
} from "./helpers.js";

/**
 * The owner's ChatGPT routes: what each answers, and that the address carrying the one-time code
 * reaches the Supervisor only through a same-origin POST with exactly the two fields it names.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const signingIn: ChatGPTConnectionView = {
  ...disconnectedChatGPT,
  login: {
    attemptId: "attempt-1",
    authorizeUrl: "https://auth.openai.com/api/accounts/authorize?state=s",
    expiresAt: 5,
  },
};

test("the connection, a started sign-in and a disconnect each answer the view", async () => {
  const supervisor = ownerApiSupervisor({
    startChatGPTLogin: () => Promise.resolve(signingIn),
    disconnectChatGPT: () => Promise.resolve(disconnectedChatGPT),
  });

  const read = await ownerApiResponse(
    new Request("https://cf-stumble.test/api/chatgpt/connection"),
    supervisor,
    ownerScope,
  );

  const started = await ownerApiResponse(
    controlRequest("/api/chatgpt/login", "{}"),
    supervisor,
    ownerScope,
  );

  const disconnected = await ownerApiResponse(
    controlRequest("/api/chatgpt/disconnect", "{}"),
    supervisor,
    ownerScope,
  );

  expect(await read.json()).toEqual({ ok: true, chatgpt: disconnectedChatGPT });
  expect(await started.json()).toEqual({ ok: true, chatgpt: signingIn });
  expect(await disconnected.json()).toEqual({ ok: true, chatgpt: disconnectedChatGPT });
});

test("finishing a sign-in passes exactly the attempt and the address, and words a refusal", async () => {
  const received: string[][] = [];

  const outcomes: ChatGPTLoginOutcome[] = [
    { ok: false, problem: { code: "wrong-sign-in" }, chatgpt: signingIn },
    { ok: false, problem: { code: "exchange-unavailable" }, chatgpt: disconnectedChatGPT },
  ];

  const supervisor = ownerApiSupervisor({
    completeChatGPTLogin: (attemptId, callbackUrl) => {
      received.push([attemptId, callbackUrl]);

      return Promise.resolve(outcomes[received.length - 1] ?? outcomes[0]!);
    },
  });

  const body = JSON.stringify({
    attemptId: "attempt-1",
    callbackUrl: "http://127.0.0.1:1455/auth/callback?code=c&state=s&client_id=a",
  });

  const refused = await ownerApiResponse(
    controlRequest("/api/chatgpt/login/complete", body),
    supervisor,
    ownerScope,
  );

  const busy = await ownerApiResponse(
    controlRequest("/api/chatgpt/login/complete", body),
    supervisor,
    ownerScope,
  );

  const extraField = await ownerApiResponse(
    controlRequest(
      "/api/chatgpt/login/complete",
      JSON.stringify({ attemptId: "a", callbackUrl: "b", clientId: "c" }),
    ),
    supervisor,
    ownerScope,
  );

  expect(refused.status).toBe(400);
  expect(await refused.json()).toEqual(outcomes[0]);
  expect(busy.status).toBe(503);
  expect(extraField.status).toBe(400);
  expect(await extraField.json()).toEqual({
    ok: false,
    error: { code: "invalid-chatgpt-request" },
  });
  expect(received).toEqual([
    ["attempt-1", "http://127.0.0.1:1455/auth/callback?code=c&state=s&client_id=a"],
    ["attempt-1", "http://127.0.0.1:1455/auth/callback?code=c&state=s&client_id=a"],
  ]);
});

test("a cross-site POST cannot start or finish a sign-in", async () => {
  const supervisor = ownerApiSupervisor();

  for (const path of [
    "/api/chatgpt/login",
    "/api/chatgpt/login/complete",
    "/api/chatgpt/disconnect",
  ]) {
    const response = await ownerApiResponse(
      new Request(`https://cf-stumble.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://elsewhere.test" },
        body: "{}",
      }),
      supervisor,
      ownerScope,
    );

    expect(response.status, path).toBe(403);
  }
});
