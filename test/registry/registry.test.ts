import { describe, expect, it } from "vitest";
import { parseSha } from "../../src/git/types.js";
import { MemoryGenerationRegistry } from "../../src/generation/registry.js";
import type { AllocationRequest } from "../../src/generation/registry-types.js";

const COMMIT = parseSha("1111111111111111111111111111111111111111");
const OTHER_COMMIT = parseSha("2222222222222222222222222222222222222222");

function request(
  idempotencyKey: string,
  commit: typeof COMMIT = COMMIT,
): AllocationRequest {
  return {
    commit,
    baseline: undefined,
    idempotencyKey,
    createdAt: 1,
  };
}

describe("MemoryGenerationRegistry", () => {
  it("allocates monotonic generation numbers and never reuses values after failures", async () => {
    const registry = new MemoryGenerationRegistry();

    const first = await registry.allocate(request("first"));
    const failed = await registry.transition(first.number, {
      state: "load_failed",
      failure: "candidate initialization failed",
    });
    const second = await registry.allocate(request("second", OTHER_COMMIT));

    expect(failed).toEqual({
      outcome: "transitioned",
      record: {
        ...first,
        state: "load_failed",
        failure: "candidate initialization failed",
      },
    });
    expect(first.number).toBe(0);
    expect(second.number).toBe(1);
    expect(await registry.get(first.number)).toMatchObject({
      number: first.number,
      state: "load_failed",
      failure: "candidate initialization failed",
    });
    expect(await registry.list()).toHaveLength(2);
  });

  it("returns the same generation for a retried idempotency key but allocates again for a new key", async () => {
    const registry = new MemoryGenerationRegistry();

    const first = await registry.allocate(request("request-1"));
    const retry = await registry.allocate(request("request-1", OTHER_COMMIT));
    const deliberateRetry = await registry.allocate(request("request-2"));

    expect(retry).toEqual(first);
    expect(retry.commit).toBe(COMMIT);
    expect(deliberateRetry.number).toBe(first.number + 1);
    expect(deliberateRetry.commit).toBe(COMMIT);
    expect(await registry.list()).toHaveLength(2);
  });
});
