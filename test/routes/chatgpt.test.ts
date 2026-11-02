import { afterEach, expect, test, vi } from "vitest";
import type { ChatGPTConnectionView, ChatGPTLoginOutcome } from "../../src/chatgpt/index.js";
import {
  controlRequest,
  disconnectedChatGPT,
  ownerApiResponse,
  ownerApiSupervisor,
} from "./helpers.js";

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
  );

  const started = await ownerApiResponse(controlRequest("/api/chatgpt/login", "{}"), supervisor);

  const disconnected = await ownerApiResponse(
    controlRequest("/api/chatgpt/disconnect", "{}"),
    supervisor,
  );

  expect(await read.json()).toEqual({ ok: true, chatgpt: disconnectedChatGPT });
  expect(await started.json()).toEqual({ ok: true, chatgpt: signingIn });
  expect(await disconnected.json()).toEqual({ ok: true, chatgpt: disconnectedChatGPT });
});

const COMPLETION_BODY = {
  attemptId: "attempt-1",
  callbackUrl: "http://127.0.0.1:1455/auth/callback?code=c&state=s&client_id=a",
};

test("finishing a sign-in hands the supervisor the attempt and the address from the body", async () => {
  const received: string[][] = [];

  const supervisor = ownerApiSupervisor({
    completeChatGPTLogin: (attemptId, callbackUrl) => {
      received.push([attemptId, callbackUrl]);

      return Promise.resolve({ ok: true, chatgpt: disconnectedChatGPT });
    },
  });

  await ownerApiResponse(
    controlRequest("/api/chatgpt/login/complete", JSON.stringify(COMPLETION_BODY)),
    supervisor,
  );

  expect(received).toEqual([[COMPLETION_BODY.attemptId, COMPLETION_BODY.callbackUrl]]);
});

test.each([
  { code: "wrong-sign-in", status: 400, chatgpt: signingIn },
  { code: "exchange-unavailable", status: 503, chatgpt: disconnectedChatGPT },
] as const)(
  "a sign-in the supervisor refuses as $code answers $status with the outcome",
  async (refusal) => {
    const outcome: ChatGPTLoginOutcome = {
      ok: false,
      problem: { code: refusal.code },
      chatgpt: refusal.chatgpt,
    };

    const response = await ownerApiResponse(
      controlRequest("/api/chatgpt/login/complete", JSON.stringify(COMPLETION_BODY)),
      ownerApiSupervisor({ completeChatGPTLogin: () => Promise.resolve(outcome) }),
    );

    expect(response.status).toBe(refusal.status);
    expect(await response.json()).toEqual(outcome);
  },
);

test("a sign-in body with a field beyond the attempt and the address never reaches the supervisor", async () => {
  let reached = false;

  const response = await ownerApiResponse(
    controlRequest(
      "/api/chatgpt/login/complete",
      JSON.stringify({ ...COMPLETION_BODY, clientId: "c" }),
    ),
    ownerApiSupervisor({
      completeChatGPTLogin: () => {
        reached = true;

        return Promise.resolve({ ok: true, chatgpt: disconnectedChatGPT });
      },
    }),
  );

  expect(response.status).toBe(400);
  expect(reached).toBe(false);
});
