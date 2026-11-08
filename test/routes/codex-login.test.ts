import { afterEach, expect, test, vi } from "vitest";
import type { CodexLoginConnectionView, CodexLoginOutcome } from "../../src/codex-login/index.js";
import {
  controlRequest,
  disconnectedCodexLogin,
  ownerApiResponse,
  ownerApiSupervisor,
} from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const signingIn: CodexLoginConnectionView = {
  ...disconnectedCodexLogin,
  login: {
    attemptId: "attempt-1",
    authorizeUrl: "https://auth.openai.com/api/accounts/authorize?state=s",
    expiresAt: 5,
  },
};

test("the connection, a started sign-in and a disconnect each answer the view", async () => {
  const supervisor = ownerApiSupervisor({
    startCodexLogin: () => Promise.resolve(signingIn),
    disconnectCodexLogin: () => Promise.resolve(disconnectedCodexLogin),
  });

  const read = await ownerApiResponse(
    new Request("https://cf-stumble.test/api/codex-login/connection"),
    supervisor,
  );

  const started = await ownerApiResponse(
    controlRequest("/api/codex-login/login", "{}"),
    supervisor,
  );

  const disconnected = await ownerApiResponse(
    controlRequest("/api/codex-login/disconnect", "{}"),
    supervisor,
  );

  expect(await read.json()).toEqual({ ok: true, codexLogin: disconnectedCodexLogin });
  expect(await started.json()).toEqual({ ok: true, codexLogin: signingIn });
  expect(await disconnected.json()).toEqual({ ok: true, codexLogin: disconnectedCodexLogin });
});

const COMPLETION_BODY = {
  attemptId: "attempt-1",
  callbackUrl: "http://127.0.0.1:1455/auth/callback?code=c&state=s&client_id=a",
};

test("finishing a sign-in hands the supervisor the attempt and the address from the body", async () => {
  const received: string[][] = [];

  const supervisor = ownerApiSupervisor({
    completeCodexLogin: (attemptId, callbackUrl) => {
      received.push([attemptId, callbackUrl]);

      return Promise.resolve({ ok: true, codexLogin: disconnectedCodexLogin });
    },
  });

  await ownerApiResponse(
    controlRequest("/api/codex-login/login/complete", JSON.stringify(COMPLETION_BODY)),
    supervisor,
  );

  expect(received).toEqual([[COMPLETION_BODY.attemptId, COMPLETION_BODY.callbackUrl]]);
});

test.each([
  { code: "wrong-sign-in", status: 400, codexLogin: signingIn },
  { code: "exchange-unavailable", status: 503, codexLogin: disconnectedCodexLogin },
] as const)(
  "a sign-in the supervisor refuses as $code answers $status with the outcome",
  async (refusal) => {
    const outcome: CodexLoginOutcome = {
      ok: false,
      problem: { code: refusal.code },
      codexLogin: refusal.codexLogin,
    };

    const response = await ownerApiResponse(
      controlRequest("/api/codex-login/login/complete", JSON.stringify(COMPLETION_BODY)),
      ownerApiSupervisor({ completeCodexLogin: () => Promise.resolve(outcome) }),
    );

    expect(response.status).toBe(refusal.status);
    expect(await response.json()).toEqual(outcome);
  },
);

test("a sign-in body with a field beyond the attempt and the address never reaches the supervisor", async () => {
  let reached = false;

  const response = await ownerApiResponse(
    controlRequest(
      "/api/codex-login/login/complete",
      JSON.stringify({ ...COMPLETION_BODY, clientId: "c" }),
    ),
    ownerApiSupervisor({
      completeCodexLogin: () => {
        reached = true;

        return Promise.resolve({ ok: true, codexLogin: disconnectedCodexLogin });
      },
    }),
  );

  expect(response.status).toBe(400);
  expect(reached).toBe(false);
});
