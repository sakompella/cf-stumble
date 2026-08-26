import { describe, expect, it } from "vitest";
import { parseSha } from "../git/types.js";
import type { AllocationRequest, GenerationRecord } from "./registry-types.js";
import { type GenerationRegistry, type MaterializationTransitionResult } from "./registry.js";
import { parseGenerationNumber } from "./types.js";

const COMMIT = parseSha("1111111111111111111111111111111111111111");
const OTHER_COMMIT = parseSha("2222222222222222222222222222222222222222");
const ARTIFACT = parseSha("3333333333333333333333333333333333333333");

type RegistryFactory = () => Promise<GenerationRegistry>;

function request(idempotencyKey: string, commit = COMMIT): AllocationRequest {
  return { commit, baseline: undefined, idempotencyKey, createdAt: 1 };
}

function transitioned(result: MaterializationTransitionResult): GenerationRecord {
  if (result.outcome !== "transitioned") {
    throw new Error("conformance setup did not transition generation");
  }
  return result.record;
}

function testAllocationBeforeLoad(makeRegistry: RegistryFactory): void {
  it("writes a loading record before the load outcome is known", async () => {
    const registry = await makeRegistry();
    const record = await registry.allocate(request("before-load"));

    expect(record.state).toBe("loading");
    expect(await registry.get(record.number)).toEqual(record);
  });
}

function testMonotonicAllocation(makeRegistry: RegistryFactory): void {
  it("allocates monotonic numbers without reuse after a failure", async () => {
    const registry = await makeRegistry();
    const first = await registry.allocate(request("first"));
    await registry.transition(first.number, { state: "load_failed", failure: "failed" });
    const second = await registry.allocate(request("second", OTHER_COMMIT));

    expect(first.number).toBe(0);
    expect(second.number).toBe(1);
    expect(await registry.list()).toHaveLength(2);
  });
}

function testIdempotency(makeRegistry: RegistryFactory): void {
  it("returns one generation for a retry and a new one for a deliberate re-attempt", async () => {
    const registry = await makeRegistry();
    const first = await registry.allocate(request("request-1"));
    const retry = await registry.allocate(request("request-1", OTHER_COMMIT));
    const deliberateRetry = await registry.allocate(request("request-2"));

    expect(retry).toEqual(first);
    expect(deliberateRetry.number).toBe(first.number + 1);
    expect(deliberateRetry.commit).toBe(COMMIT);
  });
}

function testFailureEvidence(makeRegistry: RegistryFactory): void {
  it("keeps failed materialization evidence and its artifact digest", async () => {
    const registry = await makeRegistry();
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
    expect(await registry.get(record.number)).toMatchObject({ state: "load_failed" });
  });
}

function testTerminalTransitions(makeRegistry: RegistryFactory): void {
  it("accepts loaded to validated and loaded to validation_failed, then stops", async () => {
    const registry = await makeRegistry();
    const validated = await registry.allocate(request("validated"));
    const loaded = transitioned(
      await registry.transition(validated.number, { state: "loaded", artifactDigest: ARTIFACT }),
    );
    const success = transitioned(await registry.transition(loaded.number, { state: "validated" }));
    expect(success.state).toBe("validated");

    const failed = await registry.allocate(request("validation-failure"));
    await registry.transition(failed.number, { state: "loaded" });
    const failure = transitioned(
      await registry.transition(failed.number, {
        state: "validation_failed",
        failure: "canary failed",
      }),
    );
    const retry = await registry.transition(failure.number, { state: "validated" });

    expect(failure.failure).toBe("canary failed");
    expect(retry.outcome).toBe("rejected");
  });
}

function testIllegalTransition(makeRegistry: RegistryFactory): void {
  it("rejects an illegal transition and an unknown generation", async () => {
    const registry = await makeRegistry();
    const record = await registry.allocate(request("illegal"));
    await registry.transition(record.number, { state: "load_failed", failure: "failed" });

    expect(await registry.transition(record.number, { state: "validated" })).toEqual({
      outcome: "rejected",
      reason: { kind: "illegal-transition", from: "load_failed", to: "validated" },
    });
    const unknown = parseGenerationNumber(99);
    expect(await registry.transition(unknown, { state: "validated" })).toEqual({
      outcome: "rejected",
      reason: { kind: "unknown-generation", generation: unknown },
    });
  });
}

export function describeGenerationRegistryConformance(
  name: string,
  makeRegistry: RegistryFactory,
): void {
  describe(`${name} generation registry`, () => {
    testAllocationBeforeLoad(makeRegistry);
    testMonotonicAllocation(makeRegistry);
    testIdempotency(makeRegistry);
    testFailureEvidence(makeRegistry);
    testTerminalTransitions(makeRegistry);
    testIllegalTransition(makeRegistry);
  });
}
