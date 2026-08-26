/// <reference types="@cloudflare/vitest-plugin/types" />

import { afterEach, expect, test } from "vitest";
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";

afterEach(async () => {
  await reset();
});

test("loads a facet and round-trips a message through the supervisor", async () => {
  const response = await env.SUPERVISOR.getByName("facet-spike").fetch(
    new Request("https://cf-stumble.test/facet/ping"),
  );

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("pong");
});
