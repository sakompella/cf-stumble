import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import {
  authenticateAccessRequest,
  deriveSupervisorName,
  verifyAccessToken,
} from "../src/access/index.js";
import {
  accessAgentClientId,
  accessAudience,
  accessIssuer,
  accessNow,
  accessOwnerSubject,
  signAccessToken,
  signingKey,
  type TestClaims,
} from "./access-tokens.js";

/** A signed token is valid at exactly the interval beginning at nbf and ending before exp. */
test("accepts a signed token exactly when now is between nbf and exp", async () => {
  const key = await signingKey("not-before-property", "ES256");

  await hegel.testAsync(async (tc) => {
    const now = accessNow + tc.draw(gs.integers({ minValue: -3, maxValue: 3 }));
    const exp = now + tc.draw(gs.integers({ minValue: -3, maxValue: 3 }));
    const nbf = now + tc.draw(gs.integers({ minValue: -3, maxValue: 3 }));

    const token = await signAccessToken(key, {
      iss: accessIssuer,
      aud: accessAudience,
      exp,
      nbf,
      sub: "owner-1",
    });

    const result = await verifyAccessToken({
      token,
      issuer: accessIssuer,
      audience: accessAudience,
      publicKeys: [key.publicJwk],
      now,
    });

    if (now >= exp) {
      expect(result).toEqual({ ok: false, reason: "expired" });
    } else if (now < nbf) {
      expect(result).toEqual({ ok: false, reason: "not-yet-valid" });
    } else {
      expect(result).toEqual({ ok: true, principal: { kind: "user", subject: "owner-1" } });
    }
  });
});

/**
 * A signed token reaches the owner's Supervisor exactly when its `sub` is the owner, or when it has
 * no `sub` and its `common_name` is the configured agent Client ID. Every admitted token gets the
 * owner's Supervisor name; a refused one names no Supervisor.
 */
test("admits the owner's sub or the configured agent token, and nothing else", async () => {
  const key = await signingKey("agent-token-property", "ES256");
  const publicKeys = JSON.stringify({ keys: [key.publicJwk] });

  const ownerName = await deriveSupervisorName({
    identity: accessOwnerSubject,
    audience: accessAudience,
  });

  await hegel.testAsync(async (tc) => {
    const sub = tc.draw(gs.optional(gs.sampledFrom(["", accessOwnerSubject, "someone-else"])));

    const commonName = tc.draw(
      gs.optional(gs.sampledFrom(["", accessAgentClientId, "other-client-id.access"])),
    );

    const configured = tc.draw(
      gs.optional(gs.sampledFrom(["", "  ", accessAgentClientId, `${accessAgentClientId}\n`])),
    );

    const claims: TestClaims = {
      iss: accessIssuer,
      aud: accessAudience,
      exp: accessNow + 60,
      ...(sub === null ? undefined : { sub }),
      ...(commonName === null ? undefined : { common_name: commonName }),
    };

    const result = await authenticateAccessRequest(
      new Request("https://cf-stumble.test/", {
        headers: { "cf-access-jwt-assertion": await signAccessToken(key, claims) },
      }),
      {
        CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
        CF_ACCESS_AUD: accessAudience,
        CF_ACCESS_PUBLIC_KEYS: publicKeys,
        CF_ACCESS_OWNER_SUB: accessOwnerSubject,
        ...(configured === null ? undefined : { CF_ACCESS_AGENT_CLIENT_ID: configured }),
      },
      accessNow,
    );

    const isPerson = sub !== null && sub !== "";

    const isAgent =
      !isPerson && commonName === accessAgentClientId && configured?.trim() === accessAgentClientId;

    if (sub === accessOwnerSubject || isAgent) {
      expect(result).toMatchObject({ ok: true, supervisorName: ownerName });
    } else {
      expect(result).toStrictEqual({
        ok: false,
        reason: isPerson ? "not-owner" : "missing-identity",
      });
    }
  });
});
