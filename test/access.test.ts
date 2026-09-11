/// <reference types="@cloudflare/vitest-plugin/types" />

// The test deliberately builds varied claim dictionaries to exercise the untrusted JWT boundary.
// oxlint-disable typescript/no-misused-spread, eslint/max-lines-per-function

import { SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import {
  authenticateAccessRequest,
  deriveSupervisorName,
  verifyAccessToken,
} from "../src/access/index.js";
import type { VerifyAccessTokenInput } from "../src/access/index.js";
import {
  accessAudience as audience,
  accessIssuer as issuer,
  accessNow as now,
  accessOwnerSubject,
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
    await expect(verifyAccessToken(input(signed.token, signed.key))).resolves.toEqual({
      ok: true,
      identity: "user-1",
    });
  });

  test("rejects a bad signature", async () => {
    const signed = await validToken("RS256");
    const parts = signed.token.split(".");
    const signature = parts[2] ?? "";
    // A fixed replacement character matches the original signature about one run in sixty-four.
    const changedFirst = signature.startsWith("A") ? "B" : "A";
    const tampered = `${parts[0]}.${parts[1]}.${changedFirst}${signature.slice(1)}`;
    await expect(verifyAccessToken(input(tampered, signed.key))).resolves.toMatchObject({
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

    await expect(verifyAccessToken(input(wrongIssuer, signed.key))).resolves.toMatchObject({
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

    await expect(verifyAccessToken(input(wrongAudience, signed.key))).resolves.toMatchObject({
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

    await expect(verifyAccessToken(input(expired, signed.key))).resolves.toMatchObject({
      ok: false,
      reason: "expired",
    });
  });

  test("rejects a token without the stable identity claim", async () => {
    const signed = await validToken("RS256");

    const missingIdentity = await signAccessToken(signed.key, {
      iss: issuer,
      aud: audience,
      exp: now + 60,
    });

    await expect(verifyAccessToken(input(missingIdentity, signed.key))).resolves.toMatchObject({
      ok: false,
      reason: "missing-identity",
    });
  });

  test("rejects an unauthenticated request before configuration or routing", async () => {
    await expect(
      authenticateAccessRequest(
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

  test("the Worker rejects an unauthenticated request before Supervisor routing", async () => {
    // `SELF` is the plugin's Worker entry-point fixture in this repository.
    // oxlint-disable-next-line typescript/no-deprecated
    const response = await SELF.fetch(new Request("https://cf-stumble.test/"));
    expect(response.status).toBe(401);
  });
});

describe("Access-derived Supervisor names", () => {
  test("gives distinct identities distinct names", async () => {
    await expect(deriveSupervisorName({ identity: "user-1", audience })).not.resolves.toBe(
      await deriveSupervisorName({ identity: "user-2", audience }),
    );
  });

  test("keeps the same identity stable", async () => {
    await expect(deriveSupervisorName({ identity: "user-1", audience })).resolves.toBe(
      await deriveSupervisorName({ identity: "user-1", audience }),
    );
  });
});
