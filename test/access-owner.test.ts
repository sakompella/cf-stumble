/// <reference types="@cloudflare/vitest-plugin/types" />

/**
 * A Cloudflare Access policy verifies who a caller is; `CF_ACCESS_OWNER_SUB` decides whether that
 * caller is the one owner this Worker is built for. These tests hold the second gate to its
 * contract: the configured owner passes, any other verified identity gets the same opaque 401 an
 * unauthenticated caller gets, and a missing or blank owner secret refuses everyone, including the
 * owner, rather than silently waving every verified caller through.
 */

// One describe block covers every owner-enforcement failure mode, and each needs its own signed
// token and environment, so the block runs long.
// oxlint-disable eslint/max-lines-per-function

import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { authenticateAccessRequest, type AccessWorkerEnvironment } from "../src/access/index.js";
import worker from "../src/worker.js";
import {
  accessAudience as audience,
  accessIssuer as issuer,
  accessOwnerSubject,
  signAccessToken,
  signingKey,
  type SigningKey,
} from "./access-tokens.js";

/** The Worker checks expiry against the real clock, so every token here has to be valid now. */
function tokenFor(key: SigningKey, subject: string): Promise<string> {
  return signAccessToken(key, {
    iss: issuer,
    aud: [audience],
    exp: Math.floor(Date.now() / 1000) + 600,
    sub: subject,
  });
}

function environment(key: SigningKey, ownerSub: string): AccessWorkerEnvironment {
  return {
    CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    CF_ACCESS_AUD: audience,
    CF_ACCESS_PUBLIC_KEYS: JSON.stringify({ keys: [key.publicJwk] }),
    CF_ACCESS_OWNER_SUB: ownerSub,
  };
}

function requestWith(token: string): Request {
  return new Request("https://cf-stumble.test/", {
    headers: { "cf-access-jwt-assertion": token },
  });
}

/** A full `Cloudflare.Env` for a direct `worker.fetch` call, with Access fields overridden. */
function workerEnvironment(key: SigningKey, ownerSub: string) {
  return {
    // oxlint-disable-next-line typescript/no-deprecated -- The Worker test environment is supplied by the Cloudflare Vitest plugin.
    ...env,
    ...environment(key, ownerSub),
  };
}

describe("the owner allowlist", () => {
  test("authorizes the configured owner", async () => {
    const key = await signingKey("owner-allow-key");
    const token = await tokenFor(key, accessOwnerSubject);

    await expect(
      authenticateAccessRequest(requestWith(token), environment(key, accessOwnerSubject)),
    ).resolves.toMatchObject({ ok: true });
  });

  test("rejects a correctly signed token for a different sub, deriving no Supervisor name", async () => {
    const key = await signingKey("owner-reject-key");
    const token = await tokenFor(key, "some-other-verified-user");

    const result = await authenticateAccessRequest(
      requestWith(token),
      environment(key, accessOwnerSubject),
    );

    // `AccessRequestResult` carries `supervisorName` only on the `ok: true` branch, so this
    // equality also proves no Supervisor Durable Object name exists anywhere in the result.
    expect(result).toStrictEqual({ ok: false, reason: "not-owner" });
  });

  test("a non-owner request never reaches the Supervisor, unlike an owner request", async () => {
    const key = await signingKey("owner-routing-key");
    const ownerToken = await tokenFor(key, accessOwnerSubject);
    const nonOwnerToken = await tokenFor(key, "some-other-verified-user");

    const ownerResponse = await worker.fetch(
      new Request("https://cf-stumble.test/", {
        headers: { accept: "*/*", "cf-access-jwt-assertion": ownerToken },
      }),
      workerEnvironment(key, accessOwnerSubject),
    );
    const nonOwnerResponse = await worker.fetch(
      new Request("https://cf-stumble.test/", {
        headers: { accept: "*/*", "cf-access-jwt-assertion": nonOwnerToken },
      }),
      workerEnvironment(key, accessOwnerSubject),
    );

    // No generation is active in this test, so a request that reaches the Supervisor relay gets
    // its typed 503, not a plain 401. The owner reaches it; the non-owner never does.
    expect(ownerResponse.status).toBe(503);
    expect(nonOwnerResponse.status).toBe(401);
    expect(await nonOwnerResponse.text()).toBe("Unauthorized");
  });

  test("gives a non-owner the byte-identical rejection of an unauthenticated request", async () => {
    const key = await signingKey("owner-identical-key");
    const nonOwnerToken = await tokenFor(key, "some-other-verified-user");
    const workerEnv = workerEnvironment(key, accessOwnerSubject);

    const nonOwnerResponse = await worker.fetch(
      new Request("https://cf-stumble.test/", {
        headers: { "cf-access-jwt-assertion": nonOwnerToken },
      }),
      workerEnv,
    );
    const unauthenticatedResponse = await worker.fetch(
      new Request("https://cf-stumble.test/"),
      workerEnv,
    );

    expect(nonOwnerResponse.status).toBe(unauthenticatedResponse.status);
    expect(await nonOwnerResponse.text()).toBe(await unauthenticatedResponse.text());
    expect(nonOwnerResponse.status).toBe(401);
  });

  test.each(["", "   "] as const)(
    "fails closed for the owner when the owner secret is %j",
    async (ownerSub) => {
      const key = await signingKey("owner-fail-closed-key");
      const token = await tokenFor(key, accessOwnerSubject);

      await expect(
        authenticateAccessRequest(requestWith(token), environment(key, ownerSub)),
      ).resolves.toStrictEqual({ ok: false, reason: "invalid-configuration" });
    },
  );
});
