import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";
import { activeSupervisor } from "../supervisor/helpers.js";

async function facetRequest(name: string, path: string): Promise<Response> {
  const control = await activeSupervisor(name);

  return control.fetch(new Request(`https://cf-stumble.test${path}`));
}

afterEach(async () => {
  await reset();
});

test("forwards an ordinary request to the main facet", async () => {
  const response = await facetRequest("mounted-facet-ping", "/facet/ping");

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("pong");
});

test("runs the main facet with only the model capability", async () => {
  const response = await facetRequest("mounted-facet-bindings", "/facet/bindings");

  expect(response.status).toBe(200);
  expect(await response.json(), "the running facet must receive only the model capability").toEqual(
    ["MODEL"],
  );
});

test("blocks ambient outbound requests from the main facet", async () => {
  const response = await facetRequest("mounted-facet-outbound", "/facet/outbound");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: false, error: "outbound-blocked" });
});
