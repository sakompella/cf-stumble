import { describe, expect, it } from "vitest";
import { parseSha } from "../../src/git/types.js";
import { MemoryGenerationRegistry } from "../../src/generation/registry.js";
import type { AllocationRequest } from "../../src/generation/registry-types.js";

const COMMIT = parseSha("1111111111111111111111111111111111111111");
const OTHER_COMMIT = parseSha("2222222222222222222222222222222222222222");
const ARTIFACT = parseSha("3333333333333333333333333333333333333333");

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

describe("MemoryGenerationRegistry allocation", () => {
  it("writes the loading record before the load outcome is known", async () => {
    const registry = new MemoryGenerationRegistry();

    const record = await registry.allocate(request("before-load"));

    expect(record.state).toBe("loading");
    expect(await registry.get(record.number)).toEqual(record);
  });

  it("allocates monotonic numbers and never reuses a value after a failure", async () => {
    const registry = new MemoryGenerationRegistry();
    const first = await registry.allocate(request("first"));
    await registry.transition(first.number, { state: "load_failed", failure: "failed" });

    const second = await registry.allocate(request("second", OTHER_COMMIT));

    expect(first.number).toBe(0);
    expect(second.number).toBe(1);
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

describe("MemoryGenerationRegistry materialization", () => {
  it("preserves a load_failed record rather than deleting it", async () => {
    const registry = new MemoryGenerationRegistry();
    const record = await registry.allocate(request("load-failure"));

    const failed = await registry.transition(record.number, {
      state: "load_failed",
      artifactDigest: ARTIFACT,
      failure: "candidate initialization failed",
    });

    expect(failed).toEqual({
      outcome: "transitioned",
      record: {
        ...record,
        state: "load_failed",
        artifactDigest: ARTIFACT,
        failure: "candidate initialization failed",
      },
    });
    expect(await registry.get(record.number)).toMatchObject({
      number: record.number,
      state: "load_failed",
      artifactDigest: ARTIFACT,
      failure: "candidate initialization failed",
    });
  });

  it("rejects illegal materialization transitions without overwriting immutable evidence", async () => {
    const registry = new MemoryGenerationRegistry();
    const record = await registry.allocate(request("illegal-transition"));
    const failed = await registry.transition(record.number, {
      state: "load_failed",
      failure: "loader failed",
    });

    const rejected = await registry.transition(record.number, { state: "validated" });

    expect(rejected).toEqual({
      outcome: "rejected",
      reason: { kind: "illegal-transition", from: "load_failed", to: "validated" },
    });
    expect(await registry.get(record.number)).toEqual(
      failed.outcome === "transitioned" ? failed.record : undefined,
    );
  });
});
