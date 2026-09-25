import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import { verifyAccessToken } from "../src/access/index.js";
import {
  accessAudience,
  accessIssuer,
  accessNow,
  signAccessToken,
  signingKey,
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
      expect(result).toEqual({ ok: true, identity: "owner-1" });
    }
  });
});
