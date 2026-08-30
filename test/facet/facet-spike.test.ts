/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";

function supervisorRequest(path: string): Promise<Response> {
  return env.SUPERVISOR.getByName("facet-spike").fetch(
    new Request(`https://cf-stumble.test${path}`),
  );
}

afterEach(async () => {
  await reset();
});

test("forwards an ordinary request to the main facet", async () => {
  const response = await supervisorRequest("/facet/ping");

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("pong");
});

test("runs the main facet without Supervisor bindings", async () => {
  const response = await supervisorRequest("/facet/bindings");

  expect(response.status).toBe(200);
  expect(await response.json(), "the running facet must receive no environment bindings").toEqual(
    [],
  );
});
