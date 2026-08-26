import { describe, expect, it } from "vitest";
import { parseSha } from "../../src/git/types.js";
import { MemoryGenerationRegistry } from "../../src/generation/registry.js";
import { MemoryActivationLedger } from "../../src/pointer/activation.js";
import type { AllocationRequest } from "../../src/generation/registry-types.js";
import type { GenerationNumber } from "../../src/generation/types.js";

const COMMIT = parseSha("1111111111111111111111111111111111111111");
const NO_POINTER: GenerationNumber | undefined = undefined;

function request(idempotencyKey: string): AllocationRequest {
  return {
    commit: COMMIT,
    baseline: undefined,
    idempotencyKey,
    createdAt: 1,
  };
}

async function validatedGeneration(registry: MemoryGenerationRegistry, key: string) {
  const allocated = await registry.allocate(request(key));
  await registry.transition(allocated.number, { state: "loaded" });
  const validated = await registry.transition(allocated.number, { state: "validated" });
  if (validated.outcome !== "transitioned") {
    throw new Error("test setup did not validate generation");
  }
  return validated.record;
}

describe("MemoryActivationLedger promotion", () => {
  it("rejects promotion of a non-validated generation and leaves the pointer unchanged", async () => {
    const registry = new MemoryGenerationRegistry();
    const ledger = new MemoryActivationLedger({ registry, now: () => 42 });
    const candidate = await registry.allocate(request("loading"));

    const result = await ledger.promote(candidate.number, NO_POINTER);

    expect(result).toEqual({
      outcome: "rejected",
      reason: { kind: "not-validated", state: "loading" },
    });
    expect(await ledger.readPointer()).toBeUndefined();
  });

  it("promotes a validated generation with a compare-and-swap and records the event", async () => {
    const registry = new MemoryGenerationRegistry();
    const ledger = new MemoryActivationLedger({ registry, now: () => 42 });
    const candidate = await validatedGeneration(registry, "candidate");

    const result = await ledger.promote(candidate.number, NO_POINTER);

    expect(result).toEqual({
      outcome: "activated",
      from: undefined,
      to: candidate.number,
    });
    expect(await ledger.readPointer()).toBe(candidate.number);
    expect(await ledger.readEvents()).toEqual([
      {
        sequence: 1,
        kind: "promoted",
        generation: candidate.number,
        from: undefined,
        at: 42,
      },
    ]);
  });
});

describe("MemoryActivationLedger compare-and-swap", () => {
  it("rejects a promotion with a stale expected pointer and leaves the winner intact", async () => {
    const registry = new MemoryGenerationRegistry();
    const ledger = new MemoryActivationLedger({ registry, now: () => 42 });
    const base = await validatedGeneration(registry, "base");
    const contender = await validatedGeneration(registry, "contender");
    await ledger.promote(base.number, NO_POINTER);

    const rejected = await ledger.promote(contender.number, NO_POINTER);

    expect(rejected).toEqual({
      outcome: "rejected",
      reason: { kind: "pointer-moved", expected: NO_POINTER, actual: base.number },
    });
    expect(await ledger.readPointer()).toBe(base.number);
    expect(await ledger.readEvents()).toHaveLength(1);
  });
});

describe("MemoryActivationLedger rollback", () => {
  it("rejects rollback to a generation never previously recorded as live", async () => {
    const registry = new MemoryGenerationRegistry();
    const ledger = new MemoryActivationLedger({ registry });
    const target = await validatedGeneration(registry, "never-live");

    const result = await ledger.rollback(target.number, NO_POINTER);

    expect(result).toEqual({
      outcome: "rejected",
      reason: { kind: "never-promoted", generation: target.number },
    });
    expect(await ledger.readPointer()).toBeUndefined();
  });
});
