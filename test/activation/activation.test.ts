import { describe, expect, it } from "vitest";
import { parseSha } from "../../src/git/types.js";
import { MemoryGenerationRegistry } from "../../src/generation/registry.js";
import { MemoryActivationLedger } from "../../src/pointer/activation.js";
import type {
  AllocationRequest,
  GenerationRecord,
} from "../../src/generation/registry-types.js";
import type {
  GenerationRegistry,
  MaterializationTransition,
  MaterializationTransitionResult,
} from "../../src/generation/registry.js";
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

async function validatedGeneration(registry: GenerationRegistry, key: string): Promise<GenerationRecord> {
  const allocated = await registry.allocate(request(key));
  await registry.transition(allocated.number, { state: "loaded" });
  const validated = await registry.transition(allocated.number, { state: "validated" });
  if (validated.outcome !== "transitioned") {
    throw new Error("test setup did not validate generation");
  }
  return validated.record;
}

function makeBarrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release: (() => void) | undefined;
  const allArrived = new Promise<void>((resolve) => {
    release = resolve;
  });

  return async () => {
    arrived += 1;
    if (arrived === parties) {
      if (release === undefined) {
        throw new Error("barrier release was not initialized");
      }
      release();
    }
    await allArrived;
  };
}

class TargetReadBarrierRegistry implements GenerationRegistry {
  private readonly delegate: GenerationRegistry;
  private readonly targets: ReadonlySet<GenerationNumber>;
  private readonly barrier: () => Promise<void>;

  constructor(
    delegate: GenerationRegistry,
    targets: ReadonlySet<GenerationNumber>,
    barrier: () => Promise<void>,
  ) {
    this.delegate = delegate;
    this.targets = targets;
    this.barrier = barrier;
  }

  allocate(requestValue: AllocationRequest): Promise<GenerationRecord> {
    return this.delegate.allocate(requestValue);
  }

  async get(number: GenerationNumber): Promise<GenerationRecord | undefined> {
    if (this.targets.has(number)) {
      await this.barrier();
    }
    return this.delegate.get(number);
  }

  list(): Promise<readonly GenerationRecord[]> {
    return this.delegate.list();
  }

  transition(
    number: GenerationNumber,
    next: MaterializationTransition,
  ): Promise<MaterializationTransitionResult> {
    return this.delegate.transition(number, next);
  }
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

describe("MemoryActivationLedger history", () => {
  it("represents promote, supersede, rollback, and promote again as ordered events", async () => {
    const registry = new MemoryGenerationRegistry();
    const ledger = new MemoryActivationLedger({ registry, now: () => 42 });
    const base = await validatedGeneration(registry, "base");
    const candidate = await validatedGeneration(registry, "candidate");

    expect(await ledger.promote(base.number, NO_POINTER)).toMatchObject({ outcome: "activated" });
    expect(await ledger.promote(candidate.number, base.number)).toMatchObject({ outcome: "activated" });
    expect(await ledger.rollback(base.number, candidate.number)).toMatchObject({ outcome: "activated" });
    expect(await ledger.promote(candidate.number, base.number)).toMatchObject({ outcome: "activated" });

    expect(await ledger.readPointer()).toBe(candidate.number);
    expect(await ledger.readEvents()).toEqual([
      { sequence: 1, kind: "promoted", generation: base.number, from: NO_POINTER, at: 42 },
      { sequence: 2, kind: "promoted", generation: candidate.number, from: base.number, at: 42 },
      { sequence: 3, kind: "rolled_back", generation: base.number, from: candidate.number, at: 42 },
      { sequence: 4, kind: "promoted", generation: candidate.number, from: base.number, at: 42 },
    ]);
    expect((await registry.get(candidate.number))?.state).toBe("validated");
  });
});

describe("MemoryActivationLedger concurrent promotion", () => {
  it("allows exactly one promotion from a shared base after a barrier", async () => {
    const registry = new MemoryGenerationRegistry();
    const base = await validatedGeneration(registry, "base");
    const contenders = await Promise.all(
      Array.from({ length: 8 }, (_, index) => validatedGeneration(registry, `contender-${index}`)),
    );
    const barrier = makeBarrier(contenders.length);
    const barrierRegistry = new TargetReadBarrierRegistry(
      registry,
      new Set(contenders.map(({ number }) => number)),
      barrier,
    );
    const ledger = new MemoryActivationLedger({ registry: barrierRegistry, now: () => 42 });
    expect(await ledger.promote(base.number, NO_POINTER)).toMatchObject({ outcome: "activated" });

    const results = await Promise.all(
      contenders.map(({ number }) => ledger.promote(number, base.number)),
    );
    const winners = results.filter(
      (result): result is Extract<typeof result, { outcome: "activated" }> =>
        result.outcome === "activated",
    );

    expect(winners).toHaveLength(1);
    const winner = winners[0];
    if (winner === undefined) {
      throw new Error("concurrent promotion had no winner");
    }
    expect(await ledger.readPointer()).toBe(winner.to);
    const events = await ledger.readEvents();
    expect(events).toHaveLength(2);
    expect(events.at(-1)).toEqual({
      sequence: 2,
      kind: "promoted",
      generation: winner.to,
      from: base.number,
      at: 42,
    });
  });
});

describe("MemoryActivationLedger quarantine", () => {
  it("prevents a quarantined generation from being promoted", async () => {
    const registry = new MemoryGenerationRegistry();
    const ledger = new MemoryActivationLedger({ registry });
    const candidate = await validatedGeneration(registry, "quarantined-candidate");

    expect(await ledger.quarantine(candidate.number)).toBe(true);
    const result = await ledger.promote(candidate.number, NO_POINTER);

    expect(result).toEqual({
      outcome: "rejected",
      reason: { kind: "quarantined", generation: candidate.number },
    });
    expect(await ledger.readPointer()).toBeUndefined();
  });

  it("prevents a quarantined generation from being a rollback target", async () => {
    const registry = new MemoryGenerationRegistry();
    const ledger = new MemoryActivationLedger({ registry });
    const base = await validatedGeneration(registry, "base");
    const candidate = await validatedGeneration(registry, "candidate");
    await ledger.promote(base.number, NO_POINTER);
    await ledger.promote(candidate.number, base.number);
    expect(await ledger.quarantine(base.number)).toBe(true);

    const result = await ledger.rollback(base.number, candidate.number);

    expect(result).toEqual({
      outcome: "rejected",
      reason: { kind: "quarantined", generation: base.number },
    });
    expect(await ledger.readPointer()).toBe(candidate.number);
  });
});
