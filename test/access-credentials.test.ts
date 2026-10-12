import { expect, test } from "vitest";
import { withoutAccessCredentials } from "../src/access/index.js";

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

test("removes a service token's Client ID and Client Secret headers too", () => {
  const stripped = withoutAccessCredentials(
    new Request("https://stumble.example/chat", {
      headers: {
        "CF-Access-Client-Id": "client-id.access",
        "CF-Access-Client-Secret": "client-secret-value",
        "x-keep": "kept",
      },
    }),
  );

  expect([...stripped.headers]).toEqual([["x-keep", "kept"]]);
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
