/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test } from "vitest";

function supervisorRequest(path: string, init?: RequestInit): Promise<Response> {
  return env.SUPERVISOR.getByName("supervisor-s10").fetch(
    new Request(`https://cf-stumble.test${path}`, init),
  );
}

async function readJson(response: Response): Promise<unknown> {
  return JSON.parse(await response.text());
}

function readRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected a JSON object");
  }
  return Object.fromEntries(Object.entries(value));
}

function readStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new TypeError(`expected ${key} to be a string`);
  }
  return value;
}

const candidateSource = `
import { DurableObject } from "cloudflare:workers";
export class Agent extends DurableObject {
  fetch() {
    return Response.json({ label: "candidate" });
  }
}
`;

function createGeneration(source = candidateSource): Promise<Response> {
  return supervisorRequest("/generations", {
    method: "POST",
    body: JSON.stringify({
      modules: [{ path: "agent.js", content: source, executable: false }],
      summary: "candidate generation",
      createdAt: 1_700_000_001,
    }),
  });
}

async function promoteCreatedGeneration(source = candidateSource): Promise<{
  readonly genesis: string;
  readonly candidate: string;
}> {
  const initial = readRecord(await readJson(await supervisorRequest("/live")));
  const initialGeneration = readRecord(initial["generation"]);
  const genesis = readStringField(initialGeneration, "sha");
  const createdResponse = await createGeneration(source);
  if (createdResponse.status !== 201) {
    throw new Error(await createdResponse.text());
  }
  const created = readRecord(await readJson(createdResponse));
  const generation = readRecord(created["generation"]);
  const candidate = readStringField(generation, "sha");
  const state = readRecord(await readJson(await supervisorRequest("/state")));
  const attestation = {
    candidate,
    validatedAgainst: genesis,
    corpusVersion: readStringField(state, "corpusVersion"),
    gateVersion: readStringField(state, "gateVersion"),
    verdict: "pass",
    createdAt: 1_700_000_001,
  };
  const promotion = await supervisorRequest("/promote", {
    method: "POST",
    body: JSON.stringify({ candidate, attestation }),
  });
  expect(promotion.status).toBe(200);
  return { genesis, candidate };
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

test("promotes a registered candidate and records validation evidence", async () => {
  const { candidate } = await promoteCreatedGeneration();

  const live = readRecord(await readJson(await supervisorRequest("/live")));
  expect(readStringField(readRecord(live["generation"]), "sha")).toBe(candidate);

  const results = readRecord(
    await readJson(await supervisorRequest(`/validation-results?candidate=${candidate}`)),
  );
  expect(results["results"]).toMatchObject([{ candidate, verdict: "pass" }]);
});

test("returns a structured reason for a rejected promotion", async () => {
  const initial = readRecord(await readJson(await supervisorRequest("/live")));
  const genesis = readStringField(readRecord(initial["generation"]), "sha");
  const createdResponse = await createGeneration();
  expect(createdResponse.status).toBe(201);
  const created = readRecord(await readJson(createdResponse));
  const candidate = readStringField(readRecord(created["generation"]), "sha");
  const state = readRecord(await readJson(await supervisorRequest("/state")));
  const promotion = await supervisorRequest("/promote", {
    method: "POST",
    body: JSON.stringify({
      candidate,
      attestation: {
        candidate,
        validatedAgainst: genesis,
        corpusVersion: readStringField(state, "corpusVersion"),
        gateVersion: readStringField(state, "gateVersion"),
        verdict: "fail",
        createdAt: 1_700_000_001,
      },
    }),
  });

  expect(promotion.status).toBe(422);
  expect(await readJson(promotion)).toEqual({
    outcome: "rejected",
    reason: { kind: "not-passing", verdict: "fail" },
  });
});

test("promotion rolls back every write when generation history fails", async () => {
  const initial = readRecord(await readJson(await supervisorRequest("/live")));
  const genesis = readStringField(readRecord(initial["generation"]), "sha");
  const created = readRecord(await readJson(await createGeneration()));
  const candidate = readStringField(readRecord(created["generation"]), "sha");
  const state = readRecord(await readJson(await supervisorRequest("/state")));
  const attestation = {
    candidate,
    validatedAgainst: genesis,
    corpusVersion: readStringField(state, "corpusVersion"),
    gateVersion: readStringField(state, "gateVersion"),
    verdict: "pass",
    createdAt: 1_700_000_001,
  };
  const stub = env.SUPERVISOR.getByName("supervisor-s10");
  await runInDurableObject(stub, (_instance, durableObjectState) => {
    durableObjectState.storage.sql.exec(`
      CREATE TRIGGER fail_generation_history
      BEFORE INSERT ON cf_stumble_generation_history
      BEGIN SELECT RAISE(ABORT, 'forced history failure'); END
    `);
  });

  const promotion = await supervisorRequest("/promote", {
    method: "POST",
    body: JSON.stringify({ candidate, attestation }),
  });

  expect(promotion.status).toBe(500);
  const live = readRecord(await readJson(await supervisorRequest("/live")));
  expect(readStringField(readRecord(live["generation"]), "sha")).toBe(genesis);
  const results = readRecord(
    await readJson(await supervisorRequest(`/validation-results?candidate=${candidate}`)),
  );
  expect(results["results"]).toEqual([]);
  const history = readRecord(await readJson(await supervisorRequest("/history")));
  expect(history["history"]).not.toMatchObject([{ operation: "promote", generation: candidate }]);
});

test("keeps context and corpus when rolling back", async () => {
  const { genesis, candidate } = await promoteCreatedGeneration();
  const contextWrite = await supervisorRequest("/context", {
    method: "POST",
    body: JSON.stringify({ key: "fact", value: { answer: 42 } }),
  });
  expect(contextWrite.status).toBe(201);
  const corpusWrite = await supervisorRequest("/corpus", {
    method: "POST",
    body: JSON.stringify({
      name: "canary",
      mandatoryCanary: true,
      session: {
        schemaVersion: 1,
        name: "canary-session",
        seed: 1,
        clock: { nowMs: 1_700_000_000_000 },
        initialWorkspace: [],
        turns: [],
        expectedEffects: { trace: [], finalWorkspace: [] },
      },
    }),
  });
  expect(corpusWrite.status).toBe(201);

  const rollback = await supervisorRequest("/rollback", {
    method: "POST",
    body: JSON.stringify({ target: genesis, expected: candidate }),
  });

  expect(rollback.status).toBe(200);
  expect(
    readStringField(
      readRecord(readRecord(await readJson(await supervisorRequest("/live")))["generation"]),
      "sha",
    ),
  ).toBe(genesis);
  expect(await readJson(await supervisorRequest("/context"))).toMatchObject({
    context: [{ key: "fact", value: { answer: 42 } }],
  });
  expect(await readJson(await supervisorRequest("/corpus"))).toMatchObject({
    corpus: [{ name: "canary", mandatoryCanary: true }],
  });
});

test("pins a turn to the generation it observed before promotion", async () => {
  const oldSource = `
import { DurableObject } from "cloudflare:workers";
export class Agent extends DurableObject {
  async fetch() {
    await new Promise((resolve) => {
    setTimeout(resolve, 80);
  });
    return Response.json({ label: "old" });
  }
}
`;
  await promoteCreatedGeneration(oldSource);
  const turn = supervisorRequest("/turn");
  await new Promise((resolve) => {
    setTimeout(resolve, 10);
  });
  await promoteCreatedGeneration(candidateSource);

  const turnBody = readRecord(await readJson(await turn));
  expect(readRecord(turnBody["result"])["label"]).toBe("old");
  const nextTurn = readRecord(await readJson(await supervisorRequest("/turn")));
  expect(readRecord(nextTurn["result"])["label"]).toBe("candidate");
});
