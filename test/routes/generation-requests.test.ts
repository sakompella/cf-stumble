/// <reference types="@cloudflare/vitest-plugin/types" />

import { expect, test } from "vitest";
import { routeOwnerApiRequest } from "../../src/routes/index.js";
import type { GenerationRequest } from "../../src/supervisor/control/index.js";
import { controlRequest, ownerApiSupervisor as supervisor, ownerScope } from "./helpers.js";

test("activates directly with a server-derived principal", async () => {
  let received: GenerationRequest | undefined;

  const response = await routeOwnerApiRequest(
    controlRequest("/api/generations/activate", JSON.stringify({ observedEpoch: 3, label: 2 })),
    supervisor({
      controlGeneration(request) {
        received = request;

        return Promise.resolve({ ok: false, problem: { code: "unknown-generation" } });
      },
    }),
    ownerScope,
  );

  expect(received).toEqual({
    principal: { kind: "user" },
    command: { kind: "activate", label: 2, observedEpoch: 3 },
  });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    ok: false,
    problem: { code: "unknown-generation" },
  });
});

test("rolls back through the same direct control operation", async () => {
  let received: GenerationRequest | undefined;

  const response = await routeOwnerApiRequest(
    controlRequest("/api/generations/rollback", JSON.stringify({ observedEpoch: 4, label: 0 })),
    supervisor({
      controlGeneration(request) {
        received = request;

        return Promise.resolve({ ok: false, problem: { code: "not-previously-active" } });
      },
    }),
    ownerScope,
  );

  expect(received?.command).toEqual({ kind: "rollback", label: 0, observedEpoch: 4 });
  expect(received?.principal).toEqual({ kind: "user" });
  expect(response.status).toBe(200);
});

const malformedBodies: readonly (readonly [string, string])[] = [
  ["unparsable JSON", '{"observedEpoch":'],
  ["a JSON string", '"activate"'],
  ["a missing label", '{"observedEpoch":0}'],
  ["an unknown key", '{"observedEpoch":0,"label":0,"tenant":"other"}'],
  ["a supervisor name", '{"observedEpoch":0,"label":0,"supervisorName":"other"}'],
  ["a request ID", '{"observedEpoch":0,"label":0,"requestId":"r"}'],
  ["a negative epoch", '{"observedEpoch":-1,"label":0}'],
  ["a fractional label", '{"observedEpoch":0,"label":1.5}'],
  ["a label that is not a number", '{"observedEpoch":0,"label":"0"}'],
  ["an array body", '[{"observedEpoch":0,"label":0}]'],
];

test.each(malformedBodies)(
  "rejects an activation carrying %s without reaching the Supervisor",
  async (_description, body) => {
    let invoked = false;

    const response = await routeOwnerApiRequest(
      controlRequest("/api/generations/activate", body),
      supervisor({
        controlGeneration() {
          invoked = true;

          return Promise.resolve({ ok: false, problem: { code: "stale-epoch" } });
        },
      }),
      ownerScope,
    );

    expect(invoked).toBe(false);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: "invalid-activation-request" },
    });
  },
);

test("rejects a malformed rollback with its own code", async () => {
  const response = await routeOwnerApiRequest(
    controlRequest("/api/generations/rollback", JSON.stringify({ label: 0 })),
    supervisor(),
    ownerScope,
  );

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({
    ok: false,
    error: { code: "invalid-rollback-request" },
  });
});

test("reports a control failure without echoing the internal error", async () => {
  const response = await routeOwnerApiRequest(
    controlRequest("/api/generations/activate", JSON.stringify({ observedEpoch: 0, label: 0 })),
    supervisor({
      controlGeneration() {
        return Promise.reject(new Error("Bearer token-abc leaked from SQLite"));
      },
    }),
    ownerScope,
  );

  expect(response.status).toBe(500);
  expect(await response.text()).toBe(
    JSON.stringify({ ok: false, error: { code: "internal-error" } }),
  );
});
