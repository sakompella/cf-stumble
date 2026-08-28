import { describe, expect, it } from "vitest";
import { parseSha } from "../../src/git/types.js";
import { describeGenerationRegistryConformance } from "../../src/generation/conformance.js";
import { MemoryGenerationRegistry } from "../../src/generation/registry.js";
import type { AllocationRequest } from "../../src/generation/registry-types.js";
import { parseGenerationNumber, parseGenerationNumberResult } from "../../src/generation/types.js";
import { expectErr } from "../support/result.js";

const COMMIT = parseSha("1111111111111111111111111111111111111111");
const OTHER_COMMIT = parseSha("2222222222222222222222222222222222222222");
const ARTIFACT = parseSha("3333333333333333333333333333333333333333");

describeGenerationRegistryConformance("MemoryGenerationRegistry", () =>
  Promise.resolve(new MemoryGenerationRegistry()),
);

function request(idempotencyKey: string, commit: typeof COMMIT = COMMIT): AllocationRequest {
  return {
    commit,
    baseline: undefined,
    idempotencyKey,
    createdAt: 1,
  };
}

describe("generation number parsing", () => {
  it("returns a tagged error for a request number outside the registry domain", () => {
    const error = expectErr(parseGenerationNumberResult(-1));

    expect(error).toMatchObject({ _tag: "InvalidGenerationNumberError", value: -1 });
  });
});

describe("MemoryGenerationRegistry allocation", () => {
  // Allocation-before-load and monotonic, no-reuse numbering are already pinned by
  // `describeGenerationRegistryConformance` above against this same implementation.
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

describe("MemoryGenerationRegistry load failures", () => {
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
});

describe("MemoryGenerationRegistry valid transitions", () => {
  it("follows loading through loaded to validated and records the artifact digest", async () => {
    const registry = new MemoryGenerationRegistry();
    const record = await registry.allocate(request("validated"));

    const loaded = await registry.transition(record.number, {
      state: "loaded",
      artifactDigest: ARTIFACT,
    });
    const validated = await registry.transition(record.number, { state: "validated" });

    expect(loaded).toMatchObject({
      outcome: "transitioned",
      record: { number: record.number, state: "loaded", artifactDigest: ARTIFACT },
    });
    expect(validated).toMatchObject({
      outcome: "transitioned",
      record: { number: record.number, state: "validated", artifactDigest: ARTIFACT },
    });
  });
});

describe("MemoryGenerationRegistry validation failures", () => {
  it("makes validation_failed terminal and preserves its failure reason", async () => {
    const registry = new MemoryGenerationRegistry();
    const record = await registry.allocate(request("validation-failure"));
    await registry.transition(record.number, { state: "loaded", artifactDigest: ARTIFACT });

    const failed = await registry.transition(record.number, {
      state: "validation_failed",
      failure: "canary failed",
    });
    const retry = await registry.transition(record.number, { state: "validated" });

    expect(failed).toMatchObject({
      outcome: "transitioned",
      record: {
        number: record.number,
        state: "validation_failed",
        artifactDigest: ARTIFACT,
        failure: "canary failed",
      },
    });
    expect(retry).toEqual({
      outcome: "rejected",
      reason: { kind: "illegal-transition", from: "validation_failed", to: "validated" },
    });
  });
});

describe("MemoryGenerationRegistry transition rejection", () => {
  it("returns a typed rejection for an unknown generation", async () => {
    const registry = new MemoryGenerationRegistry();
    const unknown = parseGenerationNumber(99);

    const result = await registry.transition(unknown, { state: "validated" });

    expect(result).toEqual({
      outcome: "rejected",
      reason: { kind: "unknown-generation", generation: unknown },
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
