import { expect, test } from "vitest";
import { authenticateAccessRequest, deriveSupervisorName } from "../src/access/index.js";
import {
  accessAudience as audience,
  accessNow as now,
  signAccessToken,
  signingKey,
  type SigningKey,
} from "./access-tokens.js";

/**
 * The key cache and the in-flight key load are the only state one isolate's requests share. Sharing
 * them must not share anything else: each request keeps the identity its own token proved.
 */

function token(key: SigningKey, identity: string, tokenIssuer: string): Promise<string> {
  return signAccessToken(key, { iss: tokenIssuer, aud: audience, exp: now + 60, sub: identity });
}

function request(tokenValue: string): Request {
  return new Request("https://cf-stumble.test/", {
    headers: { "cf-access-jwt-assertion": tokenValue },
  });
}

test("concurrent requests for two owners share one key load and keep their own identities", async () => {
  const key = await signingKey("two-owners-key");
  const issuerUrl = "https://twoowners.cloudflareaccess.com";
  let fetches = 0;

  const fetcher: typeof fetch = () => {
    fetches += 1;

    return new Promise((resolve) => {
      setTimeout(() => {
        resolve(new Response(JSON.stringify({ keys: [key.publicJwk] })));
      }, 5);
    });
  };

  const owners = ["owner-a", "owner-b"] as const;

  const results = await Promise.all(
    owners.map(async (owner) =>
      authenticateAccessRequest(
        request(await token(key, owner, issuerUrl)),
        {
          CF_ACCESS_TEAM_DOMAIN: "twoowners.cloudflareaccess.com",
          CF_ACCESS_AUD: audience,
          CF_ACCESS_OWNER_SUB: owner,
        },
        now,
        crypto,
        fetcher,
      ),
    ),
  );

  expect(fetches).toBe(1);
  expect(results).toStrictEqual(
    await Promise.all(
      owners.map(async (owner) => ({
        ok: true,
        supervisorName: await deriveSupervisorName({ identity: owner, audience }),
        scope: { identity: owner, audience },
      })),
    ),
  );
});
