import { env } from "cloudflare:workers";
import { afterEach, expect, test, vi } from "vitest";
import worker from "../src/worker.js";
import { ownerAuthorization, ownerRequest } from "./owner-credentials.js";

const ORIGIN = "https://cf-stumble.test";

function envWithPassword(password: string | undefined): Cloudflare.Env {
  const { OWNER_PASSWORD: _configured, ...withoutPassword } = env;

  return password === undefined
    ? withoutPassword
    : { ...withoutPassword, OWNER_PASSWORD: password };
}

afterEach(() => {
  vi.restoreAllMocks();
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

test("a missing or wrong credential gets a Basic challenge and never reaches the Supervisor", async () => {
  const getByName = vi.spyOn(env.SUPERVISOR, "getByName");
  const credentials = [undefined, ownerAuthorization("wrong"), `Basic ${btoa("root:x")}`];

  const routes = [
    ["GET", "/"],
    ["GET", "/api/status"],
    ["POST", "/health"],
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

  expect(getByName).not.toHaveBeenCalled();
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

test("an authorized POST from another origin is refused before the Supervisor, and one from its own origin or with no Origin is routed", async () => {
  const getByName = vi.spyOn(env.SUPERVISOR, "getByName");

  const post = (origin?: string) =>
    worker.fetch(
      ownerRequest(`${ORIGIN}/api/unknown`, {
        method: "POST",
        headers: origin === undefined ? {} : { origin },
      }),
      env,
    );

  const foreign = await post("https://elsewhere.test");

  expect(foreign.status).toBe(403);
  await expect(foreign.json()).resolves.toEqual({
    ok: false,
    error: { code: "cross-origin-request" },
  });
  expect(getByName).not.toHaveBeenCalled();
  expect((await post(ORIGIN)).status).toBe(404);
  expect((await post()).status).toBe(404);
  expect(getByName).toHaveBeenCalledTimes(2);
});

test("the credential check compares equal-length SHA-256 digests in constant time, whatever the password length", async () => {
  const compare = vi.spyOn(crypto.subtle, "timingSafeEqual");

  for (const password of ["", "x", "wrong".repeat(40), env.OWNER_PASSWORD ?? ""]) {
    compare.mockClear();
    await worker.fetch(
      new Request(`${ORIGIN}/api/status`, {
        headers: { authorization: ownerAuthorization(password) },
      }),
      env,
    );

    expect(compare).toHaveBeenCalledOnce();
    const [expected, presented] = compare.mock.calls[0] ?? [];
    expect([expected?.byteLength, presented?.byteLength]).toEqual([32, 32]);
  }
});
