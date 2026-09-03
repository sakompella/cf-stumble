/// <reference types="@cloudflare/vitest-plugin/types" />

import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { activeSupervisor } from "../supervisor/helpers.js";

/**
 * The Supervisor served the fixture module map from its own code, so these checks needed no
 * generation. Generation 0 is now an ordinary owner submission, so each one activates the fixture
 * commit as a generation first. What they check is unchanged: the relay reaches the running facet,
 * the facet receives only the model capability, and its ambient outbound requests stay blocked.
 */
async function facetRequest(name: string, path: string): Promise<Response> {
  const control = await activeSupervisor(name);
  return control.fetch(new Request(`https://cf-stumble.test${path}`));
}

afterEach(async () => {
  await reset();
});

test("forwards an ordinary request to the main facet", async () => {
  const response = await facetRequest("facet-spike-ping", "/facet/ping");

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("pong");
});

test("runs the main facet with only the model capability", async () => {
  const response = await facetRequest("facet-spike-bindings", "/facet/bindings");

  expect(response.status).toBe(200);
  expect(await response.json(), "the running facet must receive only the model capability").toEqual(
    ["MODEL"],
  );
});

test("blocks ambient outbound requests from the main facet", async () => {
  const response = await facetRequest("facet-spike-outbound", "/facet/outbound");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: false, error: "outbound-blocked" });
});
