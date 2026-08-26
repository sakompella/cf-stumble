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
