/// <reference types="@cloudflare/vitest-plugin/types" />

import { expect, test } from "vitest";
import { routeOwnerApiRequest } from "../../src/routes/index.js";
import type { GenerationRequest } from "../../src/supervisor/control/index.js";
import { controlRequest, ownerApiSupervisor as supervisor } from "./helpers.js";

test("activates through the journaled control operation with a server-derived principal", async () => {
  let received: GenerationRequest | undefined;
  const response = await routeOwnerApiRequest(
    controlRequest(
      "/api/generations/activate",
      JSON.stringify({ requestId: "activate-1", observedEpoch: 3, label: 2 }),
    ),
    supervisor({
      controlGeneration(request) {
        received = request;
        return Promise.resolve({ ok: false, problem: { code: "unknown-generation" } });
      },
    }),
  );

  expect(received).toEqual({
    requestId: "activate-1",
    principal: { kind: "user" },
    command: { kind: "activate", label: 2, observedEpoch: 3 },
  });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    ok: false,
    problem: { code: "unknown-generation" },
  });
});

test("rolls back through the same journaled control operation", async () => {
  let received: GenerationRequest | undefined;
  const response = await routeOwnerApiRequest(
    controlRequest(
      "/api/generations/rollback",
      JSON.stringify({ requestId: "rollback-1", observedEpoch: 4, label: 0 }),
    ),
    supervisor({
      controlGeneration(request) {
        received = request;
        return Promise.resolve({ ok: false, problem: { code: "not-previously-active" } });
      },
    }),
  );

  expect(received?.command).toEqual({ kind: "rollback", label: 0, observedEpoch: 4 });
  expect(received?.principal).toEqual({ kind: "user" });
  expect(response.status).toBe(200);
});

const malformedBodies: readonly (readonly [string, string])[] = [
  ["unparsable JSON", '{"requestId":'],
  ["a JSON string", '"activate"'],
  ["a missing label", '{"requestId":"r","observedEpoch":0}'],
  ["an unknown key", '{"requestId":"r","observedEpoch":0,"label":0,"tenant":"other"}'],
  ["a supervisor name", '{"requestId":"r","observedEpoch":0,"label":0,"supervisorName":"other"}'],
  ["an empty request ID", '{"requestId":"","observedEpoch":0,"label":0}'],
  ["a request ID that is not a string", '{"requestId":7,"observedEpoch":0,"label":0}'],
  [
    "a control character in the request ID",
    '{"requestId":"a\\u0000b","observedEpoch":0,"label":0}',
  ],
  ["a negative epoch", '{"requestId":"r","observedEpoch":-1,"label":0}'],
  ["a fractional label", '{"requestId":"r","observedEpoch":0,"label":1.5}'],
  ["a label that is not a number", '{"requestId":"r","observedEpoch":0,"label":"0"}'],
  ["an array body", '[{"requestId":"r","observedEpoch":0,"label":0}]'],
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
  );

  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({
    ok: false,
    error: { code: "invalid-rollback-request" },
  });
});

test("reports a control failure without echoing the internal error", async () => {
  const response = await routeOwnerApiRequest(
    controlRequest(
      "/api/generations/activate",
      JSON.stringify({ requestId: "activate-throws", observedEpoch: 0, label: 0 }),
    ),
    supervisor({
      controlGeneration() {
        return Promise.reject(new Error("Bearer token-abc leaked from SQLite"));
      },
    }),
  );

  expect(response.status).toBe(500);
  expect(await response.text()).toBe(
    JSON.stringify({ ok: false, error: { code: "internal-error" } }),
  );
});
