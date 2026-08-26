/// <reference types="@cloudflare/vitest-plugin/types" />
/* oxlint-disable eslint/max-lines, eslint/max-lines-per-function */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { buildGeneration } from "../../src/generation/build.js";
import { readGeneration } from "../../src/generation/read.js";
import { parseSha } from "../../src/git/types.js";
import { DurableObjectSqliteStore } from "../../src/storage/do-sqlite.js";
import { afterEach, expect, test } from "vitest";

type Credential = "valid" | "missing" | "wrong" | "empty";

function supervisorRequest(
  path: string,
  init: RequestInit = {},
  credential: Credential = "valid",
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (credential === "valid") {
    headers.set("authorization", `Bearer ${env.SUPERVISOR_SECRET}`);
  } else if (credential === "wrong") {
    headers.set("authorization", "Bearer wrong-supervisor-secret");
  } else if (credential === "empty") {
    headers.set("authorization", "Bearer ");
  }
  return env.SUPERVISOR.getByName("supervisor-s10").fetch(
    new Request(`https://cf-stumble.test${path}`, { ...init, headers }),
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

const unloadableCandidateSource = `
import { DurableObject } from "cloudflare:workers";
export class Agent extends DurableObject {
  fetch() {
    return new Response("unreachable");
  }
// missing closing brace
`;

const validationSession = {
  schemaVersion: 1,
  name: "supervisor-canary",
  seed: 1,
  clock: { nowMs: 1_700_000_000_000 },
  initialWorkspace: [],
  turns: [
    {
      input: "probe",
      modelResponses: [
        {
          requestId: "executor",
          content: JSON.stringify({ type: "final", content: "done" }),
        },
      ],
      capturedToolResults: [],
    },
  ],
  expectedEffects: { trace: [], finalWorkspace: [] },
};

async function writeValidationCase(): Promise<void> {
  const response = await supervisorRequest("/corpus", {
    method: "POST",
    body: JSON.stringify({
      name: "canary",
      mandatoryCanary: false,
      session: validationSession,
    }),
  });
  expect(response.status).toBe(201);
}

async function supervisorSnapshot(): Promise<readonly unknown[]> {
  return Promise.all([
    readJson(await supervisorRequest("/state")),
    readJson(await supervisorRequest("/generations")),
    readJson(await supervisorRequest("/context")),
    readJson(await supervisorRequest("/corpus")),
    readJson(await supervisorRequest("/validation-results")),
    readJson(await supervisorRequest("/quarantine")),
    readJson(await supervisorRequest("/history")),
  ]);
}

function createGeneration(
  source = candidateSource,
  withRuntimeDefinition = true,
): Promise<Response> {
  const modules = [{ path: "agent.js", content: source, executable: false }];
  if (withRuntimeDefinition) {
    modules.push(
      { path: "prompt.md", content: "candidate prompt\n", executable: false },
      { path: "policy.md", content: "candidate policy\n", executable: false },
    );
  }
  return supervisorRequest("/generations", {
    method: "POST",
    body: JSON.stringify({
      modules,
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
  await writeValidationCase();
  const promotion = await supervisorRequest("/promote", {
    method: "POST",
    body: JSON.stringify({ candidate }),
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
test("rejects every privileged mutation without the exact credential and preserves state", async () => {
  const before = await supervisorSnapshot();
  const requests: readonly [string, RequestInit][] = [
    ["/promote", { method: "POST", body: JSON.stringify({ candidate: "0".repeat(40) }) }],
    ["/rollback", { method: "POST", body: JSON.stringify({ target: "0".repeat(40) }) }],
    ["/reset", { method: "POST" }],
    ["/quarantine", { method: "POST", body: JSON.stringify({ target: "0".repeat(40) }) }],
    [
      "/generations",
      {
        method: "POST",
        body: JSON.stringify({
          modules: [{ path: "prompt.md", content: "candidate", executable: false }],
          summary: "candidate",
        }),
      },
    ],
    ["/context", { method: "POST", body: JSON.stringify({ key: "blocked", value: true }) }],
    [
      "/corpus",
      {
        method: "POST",
        body: JSON.stringify({
          name: "blocked",
          mandatoryCanary: false,
          session: validationSession,
        }),
      },
    ],
    [
      "/validation-results",
      {
        method: "POST",
        body: JSON.stringify({
          candidate: "0".repeat(40),
          validatedAgainst: null,
          corpusVersion: "corpus",
          gateVersion: "gate",
          verdict: "pass",
          createdAt: 1,
          caseResults: [],
        }),
      },
    ],
  ];

  for (const credential of ["missing", "wrong", "empty"] as const) {
    for (const [path, init] of requests) {
      const response = await supervisorRequest(path, init, credential);
      expect(response.status, `${credential} ${path}`).toBe(401);
      expect(await supervisorSnapshot(), `${credential} ${path}`).toEqual(before);
    }
  }
});

test("does not pass the supervisor credential into a facet", async () => {
  const probe = readRecord(await readJson(await supervisorRequest("/facet/probe")));
  expect(probe["envKeys"]).toEqual([]);
  expect(probe["envKeys"]).not.toContain("SUPERVISOR_SECRET");
  expect(probe["ownSecret"]).toBeNull();
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
test("promotes a candidate already written to the supervisor object store", async () => {
  const initial = readRecord(await readJson(await supervisorRequest("/live")));
  const genesis = readStringField(readRecord(initial["generation"]), "sha");
  const stub = env.SUPERVISOR.getByName("supervisor-s10");
  const candidate = await runInDurableObject(stub, async (_instance, state) => {
    const store = new DurableObjectSqliteStore(state);
    const parent = (await readGeneration(store, parseSha(genesis))).generation;
    const generation = await buildGeneration(store, {
      modules: [
        { path: "agent.js", content: new TextEncoder().encode(candidateSource), executable: false },
        {
          path: "prompt.md",
          content: new TextEncoder().encode("candidate prompt\n"),
          executable: false,
        },
        {
          path: "policy.md",
          content: new TextEncoder().encode("candidate policy\n"),
          executable: false,
        },
      ],
      parent,
      author: {
        name: "test builder",
        email: "builder@example.com",
        timestamp: 1_700_000_001,
        timezoneOffsetMinutes: 0,
      },
      createdAt: 1_700_000_001,
      summary: "directly stored candidate",
    });
    return generation.sha;
  });
  await writeValidationCase();
  const promotion = await supervisorRequest("/promote", {
    method: "POST",
    body: JSON.stringify({ candidate }),
  });

  expect(promotion.status).toBe(200);
  expect(
    readStringField(
      readRecord(readRecord(await readJson(await supervisorRequest("/live")))["generation"]),
      "sha",
    ),
  ).toBe(candidate);
});

test("does not promote a candidate whose worker fails the supervisor-run gate", async () => {
  const initial = readRecord(await readJson(await supervisorRequest("/live")));
  const liveBefore = readStringField(readRecord(initial["generation"]), "sha");
  const createdResponse = await createGeneration(unloadableCandidateSource);
  expect(createdResponse.status).toBe(201);
  const created = readRecord(await readJson(createdResponse));
  const candidate = readStringField(readRecord(created["generation"]), "sha");
  await writeValidationCase();

  const promotion = await supervisorRequest("/promote", {
    method: "POST",
    body: JSON.stringify({ candidate }),
  });

  expect(promotion.status).toBe(422);
  expect(await readJson(promotion)).toMatchObject({
    outcome: "rejected",
    reason: { kind: "not-passing", verdict: "inconclusive" },
  });
  const liveAfter = readRecord(await readJson(await supervisorRequest("/live")));
  expect(readStringField(readRecord(liveAfter["generation"]), "sha")).toBe(liveBefore);
});

test("returns a structured reason for a candidate rejected by the supervisor-run gate", async () => {
  const initial = readRecord(await readJson(await supervisorRequest("/live")));
  const liveBefore = readStringField(readRecord(initial["generation"]), "sha");
  const createdResponse = await createGeneration(candidateSource, false);
  expect(createdResponse.status).toBe(201);
  const created = readRecord(await readJson(createdResponse));
  const candidate = readStringField(readRecord(created["generation"]), "sha");
  await writeValidationCase();
  const promotion = await supervisorRequest("/promote", {
    method: "POST",
    body: JSON.stringify({ candidate }),
  });

  expect(promotion.status).toBe(422);
  expect(await readJson(promotion)).toEqual({
    outcome: "rejected",
    reason: { kind: "not-passing", verdict: "inconclusive" },
  });
  const liveAfter = readRecord(await readJson(await supervisorRequest("/live")));
  expect(readStringField(readRecord(liveAfter["generation"]), "sha")).toBe(liveBefore);
});

test("ignores a caller-supplied attestation and promotes only after its own gate passes", async () => {
  const initial = readRecord(await readJson(await supervisorRequest("/live")));
  const genesis = readStringField(readRecord(initial["generation"]), "sha");
  const createdResponse = await createGeneration();
  expect(createdResponse.status).toBe(201);
  const created = readRecord(await readJson(createdResponse));
  const candidate = readStringField(readRecord(created["generation"]), "sha");
  await writeValidationCase();

  const promotion = await supervisorRequest("/promote", {
    method: "POST",
    body: JSON.stringify({
      candidate,
      attestation: {
        candidate,
        validatedAgainst: genesis,
        corpusVersion: "forged-corpus",
        gateVersion: "forged-gate",
        verdict: "pass",
        createdAt: 0,
      },
    }),
  });

  expect(promotion.status).toBe(200);
  expect(await readJson(promotion)).toMatchObject({ outcome: "promoted", to: candidate });
});

test("promotion rolls back every write when generation history fails", async () => {
  const initial = readRecord(await readJson(await supervisorRequest("/live")));
  const genesis = readStringField(readRecord(initial["generation"]), "sha");
  const created = readRecord(await readJson(await createGeneration()));
  const candidate = readStringField(readRecord(created["generation"]), "sha");
  await writeValidationCase();
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
    body: JSON.stringify({ candidate }),
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

test("authorized reset restores genesis after the gate rejects a candidate", async () => {
  const { genesis } = await promoteCreatedGeneration();
  const createdResponse = await createGeneration(unloadableCandidateSource);
  expect(createdResponse.status).toBe(201);
  const created = readRecord(await readJson(createdResponse));
  const candidate = readStringField(readRecord(created["generation"]), "sha");
  await writeValidationCase();

  const failedPromotion = await supervisorRequest("/promote", {
    method: "POST",
    body: JSON.stringify({ candidate }),
  });
  expect(failedPromotion.status).toBe(422);

  const resetResponse = await supervisorRequest("/reset", { method: "POST" });
  expect(resetResponse.status).toBe(200);
  const live = readRecord(await readJson(await supervisorRequest("/live")));
  expect(readStringField(readRecord(live["generation"]), "sha")).toBe(genesis);
});

test("rejects rollback to a registered generation that was never live", async () => {
  const initial = readRecord(await readJson(await supervisorRequest("/live")));
  const genesis = readStringField(readRecord(initial["generation"]), "sha");
  const created = readRecord(await readJson(await createGeneration()));
  const candidate = readStringField(readRecord(created["generation"]), "sha");

  const rollback = await supervisorRequest("/rollback", {
    method: "POST",
    body: JSON.stringify({ target: candidate, expected: genesis }),
  });

  expect(rollback.status).toBe(422);
  expect(await readJson(rollback)).toMatchObject({ error: { kind: "not-live" } });
  const live = readRecord(await readJson(await supervisorRequest("/live")));
  expect(readStringField(readRecord(live["generation"]), "sha")).toBe(genesis);
});

test("a quarantined generation cannot be promoted or rolled back to", async () => {
  const { genesis, candidate } = await promoteCreatedGeneration();
  const quarantine = await supervisorRequest("/quarantine", {
    method: "POST",
    body: JSON.stringify({ target: candidate, reason: "failed operator review" }),
  });
  expect(quarantine.status).toBe(201);

  const leave = await supervisorRequest("/rollback", {
    method: "POST",
    body: JSON.stringify({ target: genesis, expected: candidate }),
  });
  expect(leave.status).toBe(200);

  const promotion = await supervisorRequest("/promote", {
    method: "POST",
    body: JSON.stringify({ candidate }),
  });
  expect(promotion.status).toBe(422);
  expect(await readJson(promotion)).toMatchObject({ error: { kind: "quarantined" } });

  const rollback = await supervisorRequest("/rollback", {
    method: "POST",
    body: JSON.stringify({ target: candidate, expected: genesis }),
  });
  expect(rollback.status).toBe(422);
  expect(await readJson(rollback)).toMatchObject({ error: { kind: "quarantined" } });
  const live = readRecord(await readJson(await supervisorRequest("/live")));
  expect(readStringField(readRecord(live["generation"]), "sha")).toBe(genesis);
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
