import { describe, expect, it } from "vitest";
import { parseSha } from "../../src/git/types.js";
import { PointerManager } from "../../src/pointer/index.js";
import type { Attestation } from "../../src/generation/types.js";
import { MemoryStore } from "../../src/storage/memory.js";

const LIVE = parseSha("1111111111111111111111111111111111111111");
const CANDIDATE = parseSha("2222222222222222222222222222222222222222");
const OTHER_CANDIDATE = parseSha("3333333333333333333333333333333333333333");
const NEXT_LIVE = parseSha("4444444444444444444444444444444444444444");

function makeAttestation(overrides: Partial<Attestation> = {}): Attestation {
  return {
    candidate: CANDIDATE,
    validatedAgainst: LIVE,
    corpusVersion: "corpus-1",
    gateVersion: "gate-1",
    verdict: "pass",
    createdAt: 1,
    ...overrides,
  };
}

function makeManager(store: MemoryStore): PointerManager {
  return new PointerManager({
    store,
    corpusVersion: "corpus-1",
    gateVersion: "gate-1",
  });
}

describe("PointerManager validation", () => {
  it("leaves the pointer exactly where it was when validation did not pass", async () => {
    const store = new MemoryStore();
    expect(await store.setPointer(LIVE, undefined)).toBe(true);
    const manager = makeManager(store);

    const result = await manager.promote(CANDIDATE, makeAttestation({ verdict: "fail" }));

    expect(result).toEqual({
      outcome: "rejected",
      reason: { kind: "not-passing", verdict: "fail" },
    });
    expect(await store.readPointer()).toBe(LIVE);
  });
});

describe("PointerManager promotion", () => {
  it("promotes a passing candidate from the currently live generation", async () => {
    const store = new MemoryStore();
    expect(await store.setPointer(LIVE, undefined)).toBe(true);
    const manager = makeManager(store);

    const result = await manager.promote(CANDIDATE, makeAttestation());

    expect(result).toEqual({
      outcome: "promoted",
      from: LIVE,
      to: CANDIDATE,
    });
    expect(await store.readPointer()).toBe(CANDIDATE);
  });

  it("promotes the first candidate when no live pointer exists", async () => {
    const store = new MemoryStore();
    const manager = makeManager(store);

    const result = await manager.promote(
      CANDIDATE,
      makeAttestation({ validatedAgainst: undefined }),
    );

    expect(result).toEqual({
      outcome: "promoted",
      from: undefined,
      to: CANDIDATE,
    });
    expect(await store.readPointer()).toBe(CANDIDATE);
  });
});

describe("PointerManager attestation freshness", () => {
  it("rejects an attestation validated against a generation superseded by the live pointer", async () => {
    const store = new MemoryStore();
    expect(await store.setPointer(LIVE, undefined)).toBe(true);
    const manager = makeManager(store);
    const stale = makeAttestation({ candidate: OTHER_CANDIDATE });

    expect(await manager.promote(NEXT_LIVE, makeAttestation({ candidate: NEXT_LIVE }))).toEqual({
      outcome: "promoted",
      from: LIVE,
      to: NEXT_LIVE,
    });

    const result = await manager.promote(OTHER_CANDIDATE, stale);

    expect(result).toEqual({
      outcome: "rejected",
      reason: {
        kind: "stale-attestation",
        validatedAgainst: LIVE,
        liveNow: NEXT_LIVE,
      },
    });
    expect(await store.readPointer()).toBe(NEXT_LIVE);
  });
});

describe("PointerManager attestation versions", () => {
  it("rejects an attestation whose corpus version changed", async () => {
    const store = new MemoryStore();
    expect(await store.setPointer(LIVE, undefined)).toBe(true);
    const manager = makeManager(store);

    const result = await manager.promote(CANDIDATE, makeAttestation({ corpusVersion: "corpus-0" }));

    expect(result).toEqual({
      outcome: "rejected",
      reason: {
        kind: "corpus-changed",
        attested: "corpus-0",
        current: "corpus-1",
      },
    });
    expect(await store.readPointer()).toBe(LIVE);
  });

  it("rejects an attestation whose gate version changed", async () => {
    const store = new MemoryStore();
    expect(await store.setPointer(LIVE, undefined)).toBe(true);
    const manager = makeManager(store);

    const result = await manager.promote(CANDIDATE, makeAttestation({ gateVersion: "gate-0" }));

    expect(result).toEqual({
      outcome: "rejected",
      reason: {
        kind: "gate-changed",
        attested: "gate-0",
        current: "gate-1",
      },
    });
    expect(await store.readPointer()).toBe(LIVE);
  });
});

describe("PointerManager rollback", () => {
  it("restores the prior generation through the same pointer switch in reverse", async () => {
    const store = new MemoryStore();
    expect(await store.setPointer(LIVE, undefined)).toBe(true);
    const manager = makeManager(store);

    expect(
      await manager.promote(
        CANDIDATE,
        makeAttestation({ candidate: CANDIDATE }),
      ),
    ).toEqual({ outcome: "promoted", from: LIVE, to: CANDIDATE });

    const result = await manager.rollback(LIVE, CANDIDATE);

    expect(result).toEqual({
      outcome: "promoted",
      from: CANDIDATE,
      to: LIVE,
    });
    expect(await store.readPointer()).toBe(LIVE);
  });

  it("leaves the pointer unchanged when rollback expects a superseded live generation", async () => {
    const store = new MemoryStore();
    expect(await store.setPointer(LIVE, undefined)).toBe(true);
    const manager = makeManager(store);

    const result = await manager.rollback(CANDIDATE, NEXT_LIVE);

    expect(result).toEqual({
      outcome: "rejected",
      reason: {
        kind: "pointer-moved",
        expected: NEXT_LIVE,
        actual: LIVE,
      },
    });
    expect(await store.readPointer()).toBe(LIVE);
  });
});

describe("PointerManager candidate binding", () => {
  it("rejects an attestation for a different candidate", async () => {
    const store = new MemoryStore();
    expect(await store.setPointer(LIVE, undefined)).toBe(true);
    const manager = makeManager(store);

    const result = await manager.promote(
      CANDIDATE,
      makeAttestation({ candidate: OTHER_CANDIDATE }),
    );

    expect(result).toEqual({
      outcome: "rejected",
      reason: {
        kind: "wrong-candidate",
        attested: OTHER_CANDIDATE,
        requested: CANDIDATE,
      },
    });
    expect(await store.readPointer()).toBe(LIVE);
  });
});
