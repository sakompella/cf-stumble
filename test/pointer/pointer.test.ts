import { describe, expect, it } from "vitest";
import { parseSha } from "../../src/git/types.js";
import { PointerManager } from "../../src/pointer/index.js";
import type { Attestation } from "../../src/generation/types.js";
import { MemoryStore } from "../../src/storage/memory.js";

const LIVE = parseSha("1111111111111111111111111111111111111111");
const CANDIDATE = parseSha("2222222222222222222222222222222222222222");

function makeAttestation(
  overrides: Partial<Attestation> = {},
): Attestation {
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

describe("PointerManager", () => {
  it("leaves the pointer exactly where it was when validation did not pass", async () => {
    const store = new MemoryStore();
    expect(await store.setPointer(LIVE, undefined)).toBe(true);
    const manager = new PointerManager({
      store,
      corpusVersion: "corpus-1",
      gateVersion: "gate-1",
    });

    const result = await manager.promote(
      CANDIDATE,
      makeAttestation({ verdict: "fail" }),
    );

    expect(result).toEqual({
      outcome: "rejected",
      reason: { kind: "not-passing", verdict: "fail" },
    });
    expect(await store.readPointer()).toBe(LIVE);
  });
});
