import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { ORB_PROVIDER_PATH, ORB_TOKEN_HEADER } from "../../src/orb-protocol.js";
import { providerTokenMatches } from "../../src/workspace/provider-token.js";
import worker from "../../src/worker.js";

const SECRET = "4f1c0d2e9a7b";

test.each([
  { expected: SECRET, presented: SECRET, matches: true },
  { expected: SECRET, presented: "4f1c0d2e9a7c", matches: false },
  { expected: SECRET, presented: `${SECRET}0`, matches: false },
  { expected: SECRET, presented: null, matches: false },
  { expected: undefined, presented: "", matches: false },
  { expected: "", presented: "", matches: false },
])("secret $expected, presented $presented: $matches", async ({ expected, presented, matches }) => {
  await expect(providerTokenMatches(expected, presented)).resolves.toBe(matches);
});

test("a Worker without ORB_PROVIDER_TOKEN refuses every provider connection", async () => {
  const request = new Request(`https://cf-stumble.test${ORB_PROVIDER_PATH}`, {
    headers: { upgrade: "websocket", [ORB_TOKEN_HEADER]: "" },
  });

  expect((await worker.fetch(request, env)).status).toBe(401);
});

test("the Worker does not mint provider tokens over HTTP", async () => {
  const request = new Request("https://cf-stumble.test/api/orb/provider-token", {
    method: "POST",
  });

  expect((await worker.fetch(request, env)).status).toBe(404);
});
