/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { deriveSupervisorName } from "../src/access/index.js";
import worker from "../src/worker.js";
import {
  accessAudience,
  accessIssuer,
  accessOwnerSubject,
  signAccessToken,
  signingKey,
  type SigningKey,
} from "./access-tokens.js";

const browserAccept = "text/html,application/xhtml+xml";

function workerEnvironment(key: SigningKey) {
  return {
    // oxlint-disable-next-line typescript/no-deprecated
    ...env,
    CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    CF_ACCESS_AUD: accessAudience,
    CF_ACCESS_PUBLIC_KEYS: JSON.stringify({ keys: [key.publicJwk] }),
    CF_ACCESS_OWNER_SUB: accessOwnerSubject,
  };
}

function ownerToken(key: SigningKey): Promise<string> {
  return signAccessToken(key, {
    iss: accessIssuer,
    aud: [accessAudience],
    exp: Math.floor(Date.now() / 1000) + 600,
    sub: accessOwnerSubject,
  });
}

async function supervisorSpy() {
  const name = await deriveSupervisorName({
    identity: accessOwnerSubject,
    audience: accessAudience,
  });

  // oxlint-disable-next-line typescript/no-deprecated
  const supervisor = env.SUPERVISOR.getByName(name);
  // oxlint-disable-next-line typescript/no-deprecated
  vi.spyOn(env.SUPERVISOR, "getByName").mockReturnValue(supervisor);
  let received: Request | undefined;

  const fetch = vi.spyOn(supervisor, "fetch").mockImplementation((input, init) => {
    received = new Request(input, init);

    return Promise.resolve(new Response("forwarded"));
  });

  return { fetch, getReceived: () => received };
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("strips every Access credential before forwarding a non-API request", async () => {
  const key = await signingKey("routing-forward-key");
  const token = await ownerToken(key);
  const spy = await supervisorSpy();

  const response = await worker.fetch(
    new Request("https://cf-stumble.test/chat?view=full", {
      headers: {
        "cf-access-jwt-assertion": token,
        cookie: `theme=dark; CF_Authorization=${token}; sessionId=abc`,
        "x-request-header": "kept",
      },
    }),
    workerEnvironment(key),
  );

  const received = spy.getReceived();

  expect(response.status).toBe(200);
  expect(spy.fetch).toHaveBeenCalledOnce();
  expect(received).toBeDefined();

  if (received === undefined) {
    throw new Error("the non-API request must reach the Supervisor");
  }

  expect(received.headers.has("cf-access-jwt-assertion")).toBe(false);
  const cookies = received.headers.get("cookie") ?? "";
  expect(cookies.includes("CF_Authorization=")).toBe(false);
  expect([...received.headers].some(([, value]) => value.includes(token))).toBe(false);
  expect(cookies).toContain("theme=dark");
  expect(cookies).toContain("sessionId=abc");
  expect(received.headers.get("x-request-header")).toBe("kept");
  expect(received.url).toBe("https://cf-stumble.test/chat?view=full");
});

test("routes an API request without calling Supervisor.fetch", async () => {
  const key = await signingKey("routing-api-key");
  const token = await ownerToken(key);
  const spy = await supervisorSpy();

  const response = await worker.fetch(
    new Request("https://cf-stumble.test/api/status", {
      headers: { "cf-access-jwt-assertion": token },
    }),
    workerEnvironment(key),
  );

  expect(response.status).toBe(200);
  expect(spy.fetch).not.toHaveBeenCalled();
  expect(spy.getReceived()).toBeUndefined();
});

test("serves a browser navigation without calling Supervisor.fetch", async () => {
  const key = await signingKey("routing-page-key");
  const token = await ownerToken(key);
  const spy = await supervisorSpy();

  const response = await worker.fetch(
    new Request("https://cf-stumble.test/", {
      headers: {
        accept: browserAccept,
        cookie: `CF_Authorization=${token}`,
      },
    }),
    workerEnvironment(key),
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(spy.fetch).not.toHaveBeenCalled();
  expect(spy.getReceived()).toBeUndefined();
});
