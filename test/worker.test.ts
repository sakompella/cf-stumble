import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import worker from "../src/worker.js";
import { ownerAuthorization, ownerRequest } from "./owner-credentials.js";

const ORIGIN = "https://cf-stumble.test";

function envWithPassword(password: string | undefined): Cloudflare.Env {
  const { OWNER_PASSWORD: _configured, ...withoutPassword } = env;

  return password === undefined
    ? withoutPassword
    : { ...withoutPassword, OWNER_PASSWORD: password };
}

async function chatgptSignInStarted(): Promise<boolean> {
  const response = await worker.fetch(ownerRequest(`${ORIGIN}/api/chatgpt/connection`), env);
  const { chatgpt } = await response.json<{ chatgpt: { login: object | null } }>();

  return chatgpt.login !== null;
}

afterEach(async () => {
  await reset();
});

test("with the owner's credential a request reaches the Supervisor and reads the status", async () => {
  const response = await worker.fetch(ownerRequest(`${ORIGIN}/api/status`), env);

  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  await expect(response.json()).resolves.toEqual({
    activeGeneration: { generation: null, epoch: 0 },
    mainAhead: null,
  });
});

test("a missing or wrong credential gets a Basic challenge and changes nothing", async () => {
  const credentials = [undefined, ownerAuthorization("wrong"), `Basic ${btoa("root:x")}`];

  const routes = [
    ["GET", "/"],
    ["GET", "/api/status"],
    ["POST", "/health"],
    ["POST", "/api/chatgpt/login"],
  ] as const;

  for (const authorization of credentials) {
    for (const [method, path] of routes) {
      const headers: HeadersInit = authorization === undefined ? {} : { authorization };

      const response = await worker.fetch(
        new Request(`${ORIGIN}${path}`, { method, headers }),
        env,
      );

      const challenge = response.headers.get("www-authenticate") ?? "";

      expect(response.status, `${method} ${path}`).toBe(401);
      expect(challenge.split(" ")[0]).toBe("Basic");
      expect(challenge).toMatch(/realm="cf-stumble"/u);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  }

  expect(await chatgptSignInStarted()).toBe(false);
});

test("GET /health answers without a credential, also when the secret is missing", async () => {
  for (const password of [env.OWNER_PASSWORD, undefined]) {
    const response = await worker.fetch(new Request(`${ORIGIN}/health`), envWithPassword(password));

    expect(response.status).toBe(200);
  }
});

test("without OWNER_PASSWORD the Worker answers 503, not 401, even to the right credential", async () => {
  for (const password of [undefined, ""]) {
    const response = await worker.fetch(
      ownerRequest(`${ORIGIN}/api/status`),
      envWithPassword(password),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("www-authenticate")).toBeNull();
  }
});

test("an authorized POST from another origin is refused and changes nothing, one from its own origin or with no Origin is served", async () => {
  const startSignIn = (origin?: string) =>
    worker.fetch(
      ownerRequest(`${ORIGIN}/api/chatgpt/login`, {
        method: "POST",
        headers: origin === undefined ? {} : { origin },
      }),
      env,
    );

  const foreign = await startSignIn("https://elsewhere.test");

  expect(foreign.status).toBe(403);
  await expect(foreign.json()).resolves.toEqual({
    ok: false,
    error: { code: "cross-origin-request" },
  });
  expect(await chatgptSignInStarted()).toBe(false);
  expect((await startSignIn(ORIGIN)).status).toBe(200);
  expect(await chatgptSignInStarted()).toBe(true);
  expect((await startSignIn()).status).toBe(200);
});
