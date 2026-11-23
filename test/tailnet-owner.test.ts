import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import worker from "../src/worker.js";
import { ownerRequest } from "./owner-credentials.js";

afterEach(async () => {
  await reset();
});

test("tailnet status requires the owner credential", async () => {
  const response = await worker.fetch(
    new Request("https://cf-stumble.test/api/tailnet/status"),
    env,
  );

  expect(response.status).toBe(401);
});

test("an owner HTTP request cannot proxy a tailnet fetch", async () => {
  const response = await worker.fetch(
    ownerRequest("https://cf-stumble.test/api/tailnet/fetch", {
      method: "POST",
      body: JSON.stringify({ url: "http://hp/" }),
    }),
    env,
  );

  expect(response.status).toBe(404);
});
