import { describe, expect, it } from "vitest";
import {
  MAX_RESET_ATTEMPTS,
  resetToGenesis,
  type GenesisPin,
} from "../../src/generation/genesis.js";
import { parseGenerationNumber } from "../../src/generation/types.js";
import { parseSha } from "../../src/git/types.js";
import type { Sha } from "../../src/git/types.js";
import type { PointerStore } from "../../src/storage/types.js";

const pin: GenesisPin = {
  kind: "genesis",
  sha: parseSha("0".repeat(39) + "1"),
  number: parseGenerationNumber(0),
};

/** Always loses the compare-and-swap, standing in for a sustained promotion storm. */
class AlwaysContendedPointer implements PointerStore {
  public reads = 0;

  readPointer(): Promise<Sha | undefined> {
    this.reads += 1;
    return Promise.resolve(parseSha("a".repeat(40)));
  }

  setPointer(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

describe("resetToGenesis contention", () => {
  it("gives up after a bounded number of attempts instead of spinning forever", async () => {
    const store = new AlwaysContendedPointer();

    const result = await resetToGenesis(store, pin);

    expect(result).toEqual({ outcome: "contended", attempts: MAX_RESET_ATTEMPTS });
    expect(store.reads).toBe(MAX_RESET_ATTEMPTS);
  });
});
