import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import { withoutAccessCredentials } from "../src/access/index.js";

const ordinaryCookieName = gs.sampledFrom([
  "theme",
  "session",
  "prefs",
  "trace",
  "CF_AuthorizationX",
  "XCF_Authorization",
  "cf_authorization",
]);

const cookieValue = gs.text({ alphabet: "abcXYZ012_-", minSize: 1, maxSize: 12 });

const separator = gs.sampledFrom([";", "; ", " ;", " ; "]);

/** The Access cookie can occur repeatedly and at any position; every near-miss survives in order. */
test("strips repeated Access cookies while preserving generated ordinary cookies", () => {
  hegel.test((tc) => {
    const names = tc.draw(gs.arrays(ordinaryCookieName, { maxSize: 5 }));
    const pairs = names.map((name) => `${name}=${tc.draw(cookieValue)}`);
    const accessCount = tc.draw(gs.integers({ minValue: 1, maxValue: 3 }));

    const accessPairs = Array.from(
      { length: accessCount },
      () => `CF_Authorization=${tc.draw(cookieValue)}`,
    );

    const allParts = [...pairs, ...accessPairs];
    const rotation = tc.draw(gs.integers({ minValue: 0, maxValue: allParts.length - 1 }));
    const rotated = [...allParts.slice(rotation), ...allParts.slice(0, rotation)];
    const withAccess = rotated.join(tc.draw(separator));

    const expectedCookies = rotated
      .filter((part) => !part.startsWith("CF_Authorization="))
      .join("; ");

    const stripped = withoutAccessCredentials(
      new Request("https://stumble.example/chat", {
        headers: {
          "cf-access-jwt-assertion": "generated-header-token",
          cookie: withAccess,
        },
      }),
    );

    expect(stripped.headers.get("cf-access-jwt-assertion")).toBeNull();
    expect(stripped.headers.get("cookie")).toBe(
      expectedCookies.length === 0 ? null : expectedCookies,
    );
  });
});
