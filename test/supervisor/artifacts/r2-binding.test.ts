/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";

afterEach(async () => {
  await reset();
});

test("provides a local R2 module-map binding", async () => {
  await env.MODULE_MAPS.put("module-maps/fixture", "fixture module map");

  const object = await env.MODULE_MAPS.get("module-maps/fixture");

  if (object === null) {
    throw new Error("the seeded module-map object must be readable");
  }

  expect(await object.text()).toBe("fixture module map");
});
