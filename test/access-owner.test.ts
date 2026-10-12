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

import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { authenticateAccessRequest, type AccessWorkerEnvironment } from "../src/access/index.js";
import worker from "../src/worker.js";
import {
  accessAgentClientId,
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

/** A service token's assertion: Access leaves `sub` empty and puts the Client ID in `common_name`. */
function serviceTokenFor(key: SigningKey, clientId: string): Promise<string> {
  return signAccessToken(key, {
    iss: issuer,
    aud: [audience],
    exp: Math.floor(Date.now() / 1000) + 600,
    sub: "",
    common_name: clientId,
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

  test("authorizes the configured owner when the secret has a trailing newline", async () => {
    const key = await signingKey("owner-newline-key");
    const token = await tokenFor(key, accessOwnerSubject);

    await expect(
      authenticateAccessRequest(requestWith(token), environment(key, `${accessOwnerSubject}\n`)),
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

describe("the owner's agent service token", () => {
  function agentEnvironment(
    key: SigningKey,
    agentClientId: string | undefined,
  ): AccessWorkerEnvironment {
    const ownerOnly = environment(key, accessOwnerSubject);

    return agentClientId === undefined
      ? ownerOnly
      : { ...ownerOnly, CF_ACCESS_AGENT_CLIENT_ID: agentClientId };
  }

  test("is admitted as the owner, reaching the owner's Supervisor", async () => {
    const key = await signingKey("agent-allow-key");
    const accessEnv = agentEnvironment(key, accessAgentClientId);
    const ownerToken = await tokenFor(key, accessOwnerSubject);
    const agentToken = await serviceTokenFor(key, accessAgentClientId);

    const asOwner = await authenticateAccessRequest(requestWith(ownerToken), accessEnv);
    const asAgent = await authenticateAccessRequest(requestWith(agentToken), accessEnv);

    expect(asOwner.ok).toBe(true);
    expect(asAgent).toStrictEqual(asOwner);
  });

  test("is admitted when the token has no sub claim at all", async () => {
    const key = await signingKey("agent-absent-sub-key");

    const token = await signAccessToken(key, {
      iss: issuer,
      aud: [audience],
      exp: Math.floor(Date.now() / 1000) + 600,
      common_name: accessAgentClientId,
    });

    await expect(
      authenticateAccessRequest(
        requestWith(token),
        agentEnvironment(key, `${accessAgentClientId}\n`),
      ),
    ).resolves.toMatchObject({ ok: true, scope: { identity: accessOwnerSubject } });
  });

  test("refuses any other service token", async () => {
    const key = await signingKey("agent-other-token-key");
    const token = await serviceTokenFor(key, "another-client-id.access");

    await expect(
      authenticateAccessRequest(requestWith(token), agentEnvironment(key, accessAgentClientId)),
    ).resolves.toStrictEqual({ ok: false, reason: "missing-identity" });
  });

  test.each([undefined, "", "   "])(
    "refuses the agent token when CF_ACCESS_AGENT_CLIENT_ID is %j",
    async (agentClientId) => {
      const key = await signingKey("agent-unset-key");
      const token = await serviceTokenFor(key, accessAgentClientId);

      await expect(
        authenticateAccessRequest(requestWith(token), agentEnvironment(key, agentClientId)),
      ).resolves.toStrictEqual({ ok: false, reason: "missing-identity" });
    },
  );

  test("refuses a matching common_name under a signature the team keys did not make", async () => {
    const key = await signingKey("agent-signature-key");
    const forger = await signingKey(key.publicJwk.kid);
    const forged = await serviceTokenFor(forger, accessAgentClientId);

    await expect(
      authenticateAccessRequest(requestWith(forged), agentEnvironment(key, accessAgentClientId)),
    ).resolves.toStrictEqual({ ok: false, reason: "invalid-signature" });
  });

  test("leaves a person's token to the sub check, even with the agent's common_name", async () => {
    const key = await signingKey("agent-person-key");

    const token = await signAccessToken(key, {
      iss: issuer,
      aud: [audience],
      exp: Math.floor(Date.now() / 1000) + 600,
      sub: "some-other-verified-user",
      common_name: accessAgentClientId,
    });

    await expect(
      authenticateAccessRequest(requestWith(token), agentEnvironment(key, accessAgentClientId)),
    ).resolves.toStrictEqual({ ok: false, reason: "not-owner" });
  });

  test("reaches the Supervisor through the Worker, as the owner does", async () => {
    const key = await signingKey("agent-routing-key");
    const token = await serviceTokenFor(key, accessAgentClientId);

    const workerEnv = {
      ...workerEnvironment(key, accessOwnerSubject),
      CF_ACCESS_AGENT_CLIENT_ID: accessAgentClientId,
    };

    const response = await worker.fetch(
      new Request("https://cf-stumble.test/", {
        headers: { accept: "*/*", "cf-access-jwt-assertion": token },
      }),
      workerEnv,
    );

    expect(response.status).toBe(503);
  });
});
