/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";

function supervisorRequest(path: string, init?: RequestInit): Promise<Response> {
  return env.SUPERVISOR.getByName("supervisor-s10").fetch(
    new Request(`https://cf-stumble.test${path}`, init),
  );
}

async function readJson(response: Response): Promise<unknown> {
  return JSON.parse(await response.text());
}

afterEach(async () => {
  await reset();
});

test("lists the pinned generation zero with its lineage", async () => {
  const response = await supervisorRequest("/generations");

  expect(response.status).toBe(200);
  expect(await readJson(response)).toMatchObject({
    generations: [
      {
        number: 0,
        parent: null,
        lineage: [{ number: 0, parent: null }],
      },
    ],
  });
});
