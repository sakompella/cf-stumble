import { expect, test } from "vitest";
import { authenticateAccessRequest, withoutAccessCredentials } from "../src/access/index.js";

test("removes the Access assertion and cookie before the Supervisor sees a request", () => {
  const stripped = withoutAccessCredentials(
    new Request("https://stumble.example/chat", {
      headers: {
        "cf-access-jwt-assertion": "header.payload.signature",
        cookie: "CF_Authorization=header.payload.signature; theme=dark",
        "x-keep": "kept",
      },
    }),
  );

  expect(stripped.headers.get("cf-access-jwt-assertion")).toBeNull();
  expect(stripped.headers.get("cookie")).toBe("theme=dark");
  expect(stripped.headers.get("x-keep")).toBe("kept");
  expect(JSON.stringify([...stripped.headers])).not.toContain("signature");
});

test("drops the cookie header when only the Access cookie was present", () => {
  const stripped = withoutAccessCredentials(
    new Request("https://stumble.example/chat", {
      headers: { cookie: "CF_Authorization=secret-token" },
    }),
  );

  expect(stripped.headers.get("cookie")).toBeNull();
});

test("preserves the method and body while stripping credentials", async () => {
  const stripped = withoutAccessCredentials(
    new Request("https://stumble.example/chat", {
      method: "POST",
      body: "prompt",
      headers: { "cf-access-jwt-assertion": "header.payload.signature" },
    }),
  );

  expect(stripped.method).toBe("POST");
  expect(await stripped.text()).toBe("prompt");
});

test("rejects an http team domain as invalid configuration", async () => {
  const result = await authenticateAccessRequest(
    new Request("https://stumble.example/", {
      headers: { "cf-access-jwt-assertion": "header.payload.signature" },
    }),
    {
      CF_ACCESS_TEAM_DOMAIN: "http://team.cloudflareaccess.com",
      CF_ACCESS_AUD: "audience",
    },
  );

  expect(result).toStrictEqual({ ok: false, reason: "invalid-configuration" });
});
