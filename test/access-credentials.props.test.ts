import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import { withoutAccessCredentials } from "../src/access/index.js";

const cookieName = gs.sampledFrom(["theme", "session", "prefs", "trace"]);

const cookieValue = gs.text({ alphabet: "abcXYZ012_-", maxSize: 12 });

/** The Access cookie can occur at any position; every unrelated cookie must survive verbatim. */
test("strips the Access header and cookie while preserving generated ordinary cookies", () => {
  hegel.test((tc) => {
    const names = tc.draw(gs.arrays(cookieName, { maxSize: 5 }));
    const pairs = names.map((name) => `${name}=${tc.draw(cookieValue)}`);
    const insertion = tc.draw(gs.integers({ minValue: 0, maxValue: pairs.length }));
    const withAccess = [...pairs];
    withAccess.splice(insertion, 0, "CF_Authorization=generated-access-token");

    const stripped = withoutAccessCredentials(
      new Request("https://stumble.example/chat", {
        headers: {
          "cf-access-jwt-assertion": "generated-header-token",
          cookie: withAccess.join("; "),
        },
      }),
    );

    expect(stripped.headers.get("cf-access-jwt-assertion")).toBeNull();
    expect(stripped.headers.get("cookie")).toBe(pairs.length === 0 ? null : pairs.join("; "));
  });
});
