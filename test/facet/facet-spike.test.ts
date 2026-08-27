/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { isJsonObjectValue, parseJsonValue, type JsonObject } from "../../src/json.js";
import { reset } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";

type JsonRecord = JsonObject;

function supervisorRequest(path: string): Promise<Response> {
  return env.SUPERVISOR.getByName("facet-spike").fetch(
    new Request(`https://cf-stumble.test${path}`),
  );
}

async function readRecord(response: Response): Promise<JsonRecord> {
  const value = parseJsonValue(JSON.parse(await response.text()));
  if (!isJsonObjectValue(value)) {
    throw new Error("expected a JSON object");
  }
  return value;
}

async function seedSupervisor(): Promise<void> {
  const response = await supervisorRequest("/seed");
  expect(response.status).toBe(201);
}

async function promoteHealthyCandidate(): Promise<void> {
  const candidate = await supervisorRequest("/candidate/healthy");
  expect(candidate.status).toBe(200);
  const promotion = await supervisorRequest("/promote");
  expect(promotion.status).toBe(200);
  expect((await readRecord(promotion))["promoted"]).toBe(true);
}

afterEach(async () => {
  await reset();
});

test("loads a facet and round-trips a message through the supervisor", async () => {
  const response = await supervisorRequest("/facet/ping");

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("pong");
});

test("keeps supervisor storage and facet storage separate in both directions", async () => {
  await seedSupervisor();

  const probe = await readRecord(await supervisorRequest("/facet/probe"));
  expect(probe["ownSecret"]).toBeNull();
  expect(probe["ownRows"]).toEqual([{ key: "facet-marker", value: "facet-wrote-here" }]);

  const supervisor = await readRecord(await supervisorRequest("/inspect"));
  expect(supervisor["rows"]).toEqual([
    { key: "supervisor-secret", value: "supervisor-only-secret" },
  ]);
});

test("gives the facet exactly the explicitly passed binding set", async () => {
  const probe = await readRecord(await supervisorRequest("/facet/probe"));

  expect(probe["envKeys"]).toEqual([]);
  expect(probe["envKeys"]).not.toContain("LOADER");
});

test("blocks both fetch and connect from the facet", async () => {
  const probe = await readRecord(await supervisorRequest("/facet/probe"));

  expect(probe["fetchOutcome"]).toBe("blocked");
  expect(probe["connectOutcome"]).toBe("blocked");
});

test("does not let the facet reach a supervisor route", async () => {
  await seedSupervisor();
  await promoteHealthyCandidate();

  const probe = await readRecord(await supervisorRequest("/facet/probe"));
  expect(probe["supervisorRouteOutcome"]).toBe("blocked");

  const state = await readRecord(await supervisorRequest("/state"));
  expect(state["generation"]).toBe("candidate");
});

test("resets generation 0 after a candidate fails to load", async () => {
  await seedSupervisor();
  await promoteHealthyCandidate();

  const candidate = await supervisorRequest("/candidate/syntax");
  expect(candidate.status).toBe(200);
  const failedPromotion = await supervisorRequest("/promote");
  expect(failedPromotion.status).toBe(422);
  expect((await readRecord(failedPromotion))["promoted"]).toBe(false);

  const resetResponse = await supervisorRequest("/reset");
  expect(resetResponse.status).toBe(200);
  expect((await readRecord(resetResponse))["generation"]).toBe("0");
});

test("resets generation 0 after a candidate throws during initialization", async () => {
  await seedSupervisor();
  await promoteHealthyCandidate();

  const candidate = await supervisorRequest("/candidate/init");
  expect(candidate.status).toBe(200);
  const failedPromotion = await supervisorRequest("/promote");
  expect(failedPromotion.status).toBe(422);
  expect((await readRecord(failedPromotion))["promoted"]).toBe(false);

  const resetResponse = await supervisorRequest("/reset");
  expect(resetResponse.status).toBe(200);
  expect((await readRecord(resetResponse))["generation"]).toBe("0");
});
