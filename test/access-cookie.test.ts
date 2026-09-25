/// <reference types="@cloudflare/vitest-plugin/types" />

/**
 * Cloudflare Access sets the `CF_Authorization` cookie for a signed-in browser, and a browser
 * navigation cannot send the `cf-access-jwt-assertion` header. The cookie must therefore be
 * accepted, and it must pass exactly the checks the header passes.
 */

// Each Access failure needs its own signed token, so one describe block covers them all.
// oxlint-disable eslint/max-lines-per-function

import { describe, expect, test } from "vitest";
import type { AccessWorkerEnvironment } from "../src/access/index.js";
import {
  authenticateAccessRequest,
  deriveSupervisorName,
  presentedAccessToken,
} from "../src/access/index.js";
import {
  accessAudience,
  accessIssuer,
  accessNow,
  accessOwnerSubject,
  signAccessToken,
  signingKey,
  type SigningKey,
} from "./access-tokens.js";

function environment(keys: readonly JsonWebKey[]): AccessWorkerEnvironment {
  return {
    CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    CF_ACCESS_AUD: accessAudience,
    CF_ACCESS_PUBLIC_KEYS: JSON.stringify({ keys }),
    CF_ACCESS_OWNER_SUB: accessOwnerSubject,
  };
}

// Configured keys make every check local, so a network call would be a defect rather than a cost.
const refuseNetwork: typeof fetch = () => {
  throw new Error("an Access test must not reach the network");
};

function ownerToken(key: SigningKey, identity: string): Promise<string> {
  return signAccessToken(key, {
    iss: accessIssuer,
    aud: [accessAudience],
    exp: accessNow + 60,
    sub: identity,
  });
}

function requestWith(headers: Record<string, string>): Request {
  return new Request("https://cf-stumble.test/", { headers });
}

function authenticate(
  headers: Record<string, string>,
  keys: readonly JsonWebKey[],
): ReturnType<typeof authenticateAccessRequest> {
  return authenticateAccessRequest(
    requestWith(headers),
    environment(keys),
    accessNow,
    crypto,
    refuseNetwork,
  );
}

describe("Access cookie authentication", () => {
  test("accepts a valid token from the CF_Authorization cookie", async () => {
    const key = await signingKey("cookie-key");
    const token = await ownerToken(key, "owner-1");

    await expect(
      authenticate({ cookie: `CF_Authorization=${token}` }, [key.publicJwk]),
    ).resolves.toStrictEqual({
      ok: true,
      supervisorName: await deriveSupervisorName({
        identity: "owner-1",
        audience: accessAudience,
      }),
      scope: { identity: "owner-1", audience: accessAudience },
    });
  });

  test("routes a cookie token to the same Supervisor as the same token in the header", async () => {
    const key = await signingKey("cookie-parity-key");
    const token = await ownerToken(key, "owner-1");

    const fromCookie = await authenticate({ cookie: `CF_Authorization=${token}` }, [key.publicJwk]);
    const fromHeader = await authenticate({ "cf-access-jwt-assertion": token }, [key.publicJwk]);

    expect(fromCookie).toStrictEqual(fromHeader);
  });

  test.each([
    {
      name: "expired",
      expected: "expired",
      token: (key: SigningKey) =>
        signAccessToken(key, {
          iss: accessIssuer,
          aud: accessAudience,
          exp: accessNow,
          sub: "owner-1",
        }),
    },
    {
      name: "signed by another key",
      expected: "invalid-signature",
      token: async (_key: SigningKey) => {
        const attacker = await signingKey("cookie-attacker-key");

        return ownerToken(attacker, "owner-1");
      },
    },
    {
      name: "issued for another Access application",
      expected: "wrong-audience",
      token: (key: SigningKey) =>
        signAccessToken(key, {
          iss: accessIssuer,
          aud: "other-application",
          exp: accessNow + 60,
          sub: "owner-1",
        }),
    },
    {
      name: "issued by another team domain",
      expected: "wrong-issuer",
      token: (key: SigningKey) =>
        signAccessToken(key, {
          iss: "https://other.cloudflareaccess.com",
          aud: accessAudience,
          exp: accessNow + 60,
          sub: "owner-1",
        }),
    },
  ])(
    "applies the same rejection to a cookie as to its header ($name)",
    async ({ expected, token }) => {
      const configured = await signingKey(`cookie-parity-${expected}`);
      const tokenValue = await token(configured);

      const fromCookie = await authenticate({ cookie: `CF_Authorization=${tokenValue}` }, [
        configured.publicJwk,
      ]);

      const fromHeader = await authenticate({ "cf-access-jwt-assertion": tokenValue }, [
        configured.publicJwk,
      ]);

      expect(fromCookie).toStrictEqual({ ok: false, reason: expected });
      expect(fromCookie).toStrictEqual(fromHeader);
    },
  );

  test("treats a malformed cookie value exactly like a malformed header", async () => {
    const key = await signingKey("cookie-malformed-key");

    const fromCookie = await authenticate({ cookie: "CF_Authorization=not-a-token" }, [
      key.publicJwk,
    ]);

    const fromHeader = await authenticate({ "cf-access-jwt-assertion": "not-a-token" }, [
      key.publicJwk,
    ]);

    expect(fromCookie).toStrictEqual({ ok: false, reason: "malformed-token" });
    expect(fromCookie).toStrictEqual(fromHeader);
  });

  test("treats an absent Access cookie exactly like an absent header", async () => {
    const key = await signingKey("cookie-absent-key");

    await expect(
      authenticate({ cookie: "theme=dark; cf_authorization=lowercase" }, [key.publicJwk]),
    ).resolves.toStrictEqual({ ok: false, reason: "malformed-token" });
    await expect(authenticate({}, [key.publicJwk])).resolves.toStrictEqual({
      ok: false,
      reason: "malformed-token",
    });
  });

  test("keeps the rejected cookie token out of the result", async () => {
    const configured = await signingKey("cookie-silence-key");
    const attacker = await signingKey("cookie-silence-attacker");
    const forged = await ownerToken(attacker, "owner-1");

    const result = await authenticate({ cookie: `CF_Authorization=${forged}` }, [
      configured.publicJwk,
    ]);

    expect(JSON.stringify(result)).not.toContain(forged);
  });

  test("rejects a request whose header fails even though its cookie would pass", async () => {
    const key = await signingKey("cookie-no-fallback-key");
    const valid = await ownerToken(key, "owner-1");

    const expired = await signAccessToken(key, {
      iss: accessIssuer,
      aud: accessAudience,
      exp: accessNow,
      sub: "owner-1",
    });

    await expect(
      authenticate({ "cf-access-jwt-assertion": expired, cookie: `CF_Authorization=${valid}` }, [
        key.publicJwk,
      ]),
    ).resolves.toStrictEqual({ ok: false, reason: "expired" });
  });
});

describe("locating the presented Access token", () => {
  test.each([
    {
      name: "prefers the header value over the cookie value",
      headers: {
        "cf-access-jwt-assertion": "header-token",
        cookie: "CF_Authorization=cookie-token",
      },
      expected: "header-token",
    },
    {
      name: "reads the cookie value when the header is empty",
      headers: {
        "cf-access-jwt-assertion": "",
        cookie: "CF_Authorization=cookie-token",
      },
      expected: "cookie-token",
    },
  ])("$name", ({ headers, expected }) => {
    expect(presentedAccessToken(requestWith(headers))).toBe(expected);
  });
});
