import { expect, test } from "vitest";
import type { ControlProblemCode } from "../../src/supervisor/generations.js";
import { controlRequest, ownerApiResponse, ownerApiSupervisor as supervisor } from "./helpers.js";

const refusalStatuses: readonly (readonly [ControlProblemCode, number])[] = [
  ["unknown-generation", 404],
  ["stale-epoch", 409],
  ["not-ready", 409],
  ["not-previously-active", 409],
];

test.each(refusalStatuses)(
  "a %s refusal answers HTTP %i and keeps its code in the body",
  async (code, status) => {
    const response = await ownerApiResponse(
      controlRequest("/api/generations/activate", JSON.stringify({ observedEpoch: 3, label: 2 })),
      supervisor({ controlGeneration: () => Promise.resolve({ ok: false, problem: { code } }) }),
    );

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ ok: false, problem: { code } });
  },
);
