import { describe, expect, it } from "vitest";
import { parseSha } from "../git/types.js";
import type {
  ActivationEvent,
  ActivationResult,
  AllocationRequest,
  GenerationRecord,
} from "../generation/registry-types.js";
import type { GenerationRegistry } from "../generation/registry.js";
import type { GenerationNumber } from "../generation/types.js";
import type { ActivationLedger } from "./activation.js";

const COMMIT = parseSha("1111111111111111111111111111111111111111");
const NO_POINTER: GenerationNumber | undefined = undefined;

type ActivationEventSummary = {
  readonly sequence: number;
  readonly kind: ActivationEvent["kind"];
  readonly generation: GenerationNumber;
  readonly from: GenerationNumber | undefined;
};

type ActivationFixture = {
  readonly registry: GenerationRegistry;
  readonly ledger: ActivationLedger;
};
type ActivationFactory = () => Promise<ActivationFixture>;

function request(idempotencyKey: string): AllocationRequest {
  return { commit: COMMIT, baseline: undefined, idempotencyKey, createdAt: 1 };
}

async function validatedGeneration(
  registry: GenerationRegistry,
  key: string,
): Promise<GenerationRecord> {
  const allocated = await registry.allocate(request(key));
  await registry.transition(allocated.number, { state: "loaded" });
  const result = await registry.transition(allocated.number, { state: "validated" });
  if (result.outcome !== "transitioned") {
    throw new Error("conformance setup did not validate generation");
  }
  return result.record;
}

function activated(result: ActivationResult): Extract<ActivationResult, { outcome: "activated" }> {
  if (result.outcome !== "activated") {
    throw new Error("conformance setup did not activate generation");
  }
  return result;
}

function testValidation(makeFixture: ActivationFactory): void {
  it("rejects non-validated promotion and leaves the pointer unchanged", async () => {
    const { registry, ledger } = await makeFixture();
    const candidate = await registry.allocate(request("loading"));

    const result = await ledger.promote(candidate.number, NO_POINTER);

    expect(result).toEqual({
      outcome: "rejected",
      reason: { kind: "not-validated", state: "loading" },
    });
    expect(await ledger.readPointer()).toBeUndefined();
  });
}

function testPromotion(makeFixture: ActivationFactory): void {
  it("promotes a validated generation and appends one promotion event", async () => {
    const { registry, ledger } = await makeFixture();
    const candidate = await validatedGeneration(registry, "candidate");

    const result = activated(await ledger.promote(candidate.number, NO_POINTER));
    const events = await ledger.readEvents();

    expect(result).toEqual({ outcome: "activated", from: NO_POINTER, to: candidate.number });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sequence: 1,
      kind: "promoted",
      generation: candidate.number,
      from: NO_POINTER,
    });
  });
}

function testCompareAndSwap(makeFixture: ActivationFactory): void {
  it("rejects stale promotion expectations without appending an event", async () => {
    const { registry, ledger } = await makeFixture();
    const base = await validatedGeneration(registry, "base");
    const candidate = await validatedGeneration(registry, "candidate");
    activated(await ledger.promote(base.number, NO_POINTER));

    const result = await ledger.promote(candidate.number, NO_POINTER);

    expect(result).toEqual({
      outcome: "rejected",
      reason: { kind: "pointer-moved", expected: NO_POINTER, actual: base.number },
    });
    expect(await ledger.readPointer()).toBe(base.number);
    expect(await ledger.readEvents()).toHaveLength(1);
  });
}

function testRollbackGuard(makeFixture: ActivationFactory): void {
  it("rejects rollback to a generation that was never live", async () => {
    const { registry, ledger } = await makeFixture();
    const target = await validatedGeneration(registry, "never-live");

    const result = await ledger.rollback(target.number, NO_POINTER);

    expect(result).toEqual({
      outcome: "rejected",
      reason: { kind: "never-promoted", generation: target.number },
    });
    expect(await ledger.readEvents()).toEqual([]);
  });
}

function testHistory(makeFixture: ActivationFactory): void {
  it("keeps promotion, rollback, and re-promotion as append-only history", async () => {
    const { registry, ledger } = await makeFixture();
    const base = await validatedGeneration(registry, "base");
    const candidate = await validatedGeneration(registry, "candidate");

    activated(await ledger.promote(base.number, NO_POINTER));
    activated(await ledger.promote(candidate.number, base.number));
    activated(await ledger.rollback(base.number, candidate.number));
    activated(await ledger.promote(candidate.number, base.number));

    const events = await ledger.readEvents();
    expect(await ledger.readPointer()).toBe(candidate.number);
    expect(events.map((event) => eventSummary(event))).toEqual([
      { sequence: 1, kind: "promoted", generation: base.number, from: NO_POINTER },
      { sequence: 2, kind: "promoted", generation: candidate.number, from: base.number },
      { sequence: 3, kind: "rolled_back", generation: base.number, from: candidate.number },
      { sequence: 4, kind: "promoted", generation: candidate.number, from: base.number },
    ]);
  });
}

function testQuarantine(makeFixture: ActivationFactory): void {
  it("blocks quarantined generations from promotion and rollback", async () => {
    const { registry, ledger } = await makeFixture();
    const base = await validatedGeneration(registry, "base");
    const candidate = await validatedGeneration(registry, "candidate");
    expect(await ledger.quarantine(candidate.number)).toBe(true);
    expect(await ledger.promote(candidate.number, NO_POINTER)).toEqual({
      outcome: "rejected",
      reason: { kind: "quarantined", generation: candidate.number },
    });

    activated(await ledger.promote(base.number, NO_POINTER));
    expect(await ledger.quarantine(base.number)).toBe(true);
    expect(await ledger.rollback(base.number, NO_POINTER)).toEqual({
      outcome: "rejected",
      reason: { kind: "quarantined", generation: base.number },
    });
    expect(await ledger.readPointer()).toBe(base.number);
  });
}

function eventSummary(event: ActivationEvent): ActivationEventSummary {
  return {
    sequence: event.sequence,
    kind: event.kind,
    generation: event.generation,
    from: event.from,
  } satisfies ActivationEventSummary;
}

export function describeActivationLedgerConformance(
  name: string,
  makeFixture: ActivationFactory,
): void {
  describe(`${name} activation ledger`, () => {
    testValidation(makeFixture);
    testPromotion(makeFixture);
    testCompareAndSwap(makeFixture);
    testRollbackGuard(makeFixture);
    testHistory(makeFixture);
    testQuarantine(makeFixture);
  });
}
