// oxlint-disable eslint/max-lines-per-function -- One describe callback registers every claim case for the untrusted JWT boundary.

import { exports as workerExports } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { accessResult, supervisorNameFor, verificationResult } from "./access-results.js";
import type { VerifyAccessTokenInput } from "../src/access/index.js";
import {
  accessAudience as audience,
  accessIssuer as issuer,
  accessNow as now,
  accessOwnerSubject,
  encode,
  signAccessToken,
  signingKey,
  type SigningAlgorithm,
  type SigningKey,
} from "./access-tokens.js";

function input(tokenValue: string, key: SigningKey): VerifyAccessTokenInput {
  return {
    token: tokenValue,
    issuer,
    audience,
    publicKeys: [key.publicJwk],
    now,
  };
}

async function validToken(
  algorithm: SigningAlgorithm,
  identity = "user-1",
): Promise<{ token: string; key: SigningKey }> {
  const key = await signingKey(`${algorithm}-key`, algorithm);

  const tokenValue = await signAccessToken(key, {
    iss: issuer,
    aud: [audience],
    exp: now + 60,
    sub: identity,
  });

  return { token: tokenValue, key };
}

describe("Cloudflare Access JWT verification", () => {
  test.each(["RS256", "ES256"] as const)("accepts a valid %s token", async (algorithm) => {
    const signed = await validToken(algorithm);
    await expect(verificationResult(input(signed.token, signed.key))).resolves.toEqual({
      ok: true,
      principal: { kind: "user", subject: "user-1" },
    });
  });

  test("rejects a bad signature", async () => {
    const signed = await validToken("RS256");
    const parts = signed.token.split(".");
    const signature = parts[2] ?? "";
    // A fixed replacement character matches the original signature about one run in sixty-four.
    const changedFirst = signature.startsWith("A") ? "B" : "A";
    const tampered = `${parts[0]}.${parts[1]}.${changedFirst}${signature.slice(1)}`;
    await expect(verificationResult(input(tampered, signed.key))).resolves.toMatchObject({
      ok: false,
      reason: "invalid-signature",
    });
  });

  test("rejects a wrong issuer", async () => {
    const signed = await validToken("RS256");

    const wrongIssuer = await signAccessToken(signed.key, {
      iss: "https://other.cloudflareaccess.com",
      aud: audience,
      exp: now + 60,
      sub: "user-1",
    });

    await expect(verificationResult(input(wrongIssuer, signed.key))).resolves.toMatchObject({
      ok: false,
      reason: "wrong-issuer",
    });
  });

  test("rejects a wrong audience", async () => {
    const signed = await validToken("RS256");

    const wrongAudience = await signAccessToken(signed.key, {
      iss: issuer,
      aud: ["other-application"],
      exp: now + 60,
      sub: "user-1",
    });

    await expect(verificationResult(input(wrongAudience, signed.key))).resolves.toMatchObject({
      ok: false,
      reason: "wrong-audience",
    });
  });

  test("rejects an expired token", async () => {
    const signed = await validToken("RS256");

    const expired = await signAccessToken(signed.key, {
      iss: issuer,
      aud: audience,
      exp: now,
      sub: "user-1",
    });

    await expect(verificationResult(input(expired, signed.key))).resolves.toMatchObject({
      ok: false,
      reason: "expired",
    });
  });

  test("rejects a token that is not yet valid", async () => {
    const signed = await validToken("RS256");

    const notYetValid = await signAccessToken(signed.key, {
      iss: issuer,
      aud: audience,
      exp: now + 60,
      nbf: now + 1,
      sub: "user-1",
    });

    await expect(verificationResult(input(notYetValid, signed.key))).resolves.toMatchObject({
      ok: false,
      reason: "not-yet-valid",
    });
  });

  test("rejects a token without the stable identity claim", async () => {
    const signed = await validToken("RS256");

    const missingIdentity = await signAccessToken(signed.key, {
      iss: issuer,
      aud: audience,
      exp: now + 60,
    });

    await expect(verificationResult(input(missingIdentity, signed.key))).resolves.toMatchObject({
      ok: false,
      reason: "missing-identity",
    });
  });

  test("reads a service token's Client ID from common_name when sub is empty", async () => {
    const signed = await validToken("RS256");

    const serviceToken = await signAccessToken(signed.key, {
      iss: issuer,
      aud: [audience],
      exp: now + 60,
      sub: "",
      common_name: "client-id.access",
    });

    await expect(verificationResult(input(serviceToken, signed.key))).resolves.toEqual({
      ok: true,
      principal: { kind: "service-token", clientId: "client-id.access" },
    });
  });

  test("rejects an empty sub that carries no common_name", async () => {
    const signed = await validToken("RS256");

    const claims = { iss: issuer, aud: [audience], exp: now + 60, sub: "" };

    for (const anonymousClaims of [claims, { ...claims, common_name: "" }]) {
      const anonymous = await signAccessToken(signed.key, anonymousClaims);

      await expect(verificationResult(input(anonymous, signed.key))).resolves.toEqual({
        ok: false,
        reason: "missing-identity",
      });
    }
  });

  test("keeps a person's sub when the token also carries a common_name", async () => {
    const signed = await validToken("RS256");

    const both = await signAccessToken(signed.key, {
      iss: issuer,
      aud: [audience],
      exp: now + 60,
      sub: "user-1",
      common_name: "client-id.access",
    });

    await expect(verificationResult(input(both, signed.key))).resolves.toEqual({
      ok: true,
      principal: { kind: "user", subject: "user-1" },
    });
  });

  test.each(["none", "HS256", "RS512"])("refuses a token whose header names %s", async (alg) => {
    const signed = await validToken("RS256");
    const [, claims, signature] = signed.token.split(".");
    const header = encode(JSON.stringify({ alg, kid: signed.key.publicJwk.kid }));

    await expect(
      verificationResult(input(`${header}.${claims}.${signature}`, signed.key)),
    ).resolves.toEqual({ ok: false, reason: "unsupported-algorithm" });
  });

  test("refuses a key with the token's kid that is published for another algorithm", async () => {
    const signed = await validToken("RS256");
    const otherFamily = await signingKey(signed.key.publicJwk.kid, "ES256");

    for (const publicJwk of [{ ...signed.key.publicJwk, alg: "ES256" }, otherFamily.publicJwk]) {
      await expect(
        verificationResult({ ...input(signed.token, signed.key), publicKeys: [publicJwk] }),
      ).resolves.toEqual({ ok: false, reason: "invalid-signature" });
    }
  });

  test("rejects an unauthenticated request before configuration or routing", async () => {
    await expect(
      accessResult(
        new Request("https://cf-stumble.test/"),
        {
          CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
          CF_ACCESS_AUD: audience,
          CF_ACCESS_OWNER_SUB: accessOwnerSubject,
        },
        now,
      ),
    ).resolves.toEqual({ ok: false, reason: "malformed-token" });
  });

  // The first request in this file loads the whole Worker module, which exceeds Vitest's 5 s default
  // on a busy machine; the assertion is about routing, not load time.
  test("the Worker rejects an unauthenticated request before Supervisor routing", async () => {
    const response = await workerExports.default.fetch(new Request("https://cf-stumble.test/"));
    expect(response.status).toBe(401);
  }, 30_000);
});

test("rejects an http team domain as invalid configuration", async () => {
  const result = await accessResult(
    new Request("https://stumble.example/", {
      headers: { "cf-access-jwt-assertion": "header.payload.signature" },
    }),
    {
      CF_ACCESS_TEAM_DOMAIN: "http://team.cloudflareaccess.com",
      CF_ACCESS_AUD: "audience",
      CF_ACCESS_OWNER_SUB: accessOwnerSubject,
    },
  );

  expect(result).toStrictEqual({ ok: false, reason: "invalid-configuration" });
});

describe("Access-derived Supervisor names", () => {
  test("gives distinct identities distinct names", async () => {
    await expect(supervisorNameFor({ identity: "user-1", audience })).not.resolves.toBe(
      await supervisorNameFor({ identity: "user-2", audience }),
    );
  });

  test("keeps the same identity stable", async () => {
    await expect(supervisorNameFor({ identity: "user-1", audience })).resolves.toBe(
      await supervisorNameFor({ identity: "user-1", audience }),
    );
  });
});
