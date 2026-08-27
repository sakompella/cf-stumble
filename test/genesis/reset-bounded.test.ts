import { Result } from "better-result";
import { describe, expect, it } from "vitest";
import {
  MAX_RESET_ATTEMPTS,
  resetToGenesis,
  type GenesisPin,
} from "../../src/generation/genesis.js";
import { parseSha } from "../../src/git/types.js";
import type { PointerStore } from "../../src/storage/types.js";
import { expectOk } from "../support/result.js";

const pin: GenesisPin = {
  kind: "genesis",
  sha: parseSha("0".repeat(39) + "1"),
};

/** Always loses the compare-and-swap, standing in for a sustained promotion storm. */
class AlwaysContendedPointer implements PointerStore {
  public reads = 0;

  readPointer(): ReturnType<PointerStore["readPointer"]> {
    this.reads += 1;
    return Promise.resolve(Result.ok(parseSha("a".repeat(40))));
  }

  setPointer(): ReturnType<PointerStore["setPointer"]> {
    return Promise.resolve(Result.ok(false));
  }
}

describe("resetToGenesis contention", () => {
  it("gives up after a bounded number of attempts instead of spinning forever", async () => {
    const store = new AlwaysContendedPointer();

    const result = expectOk(await resetToGenesis(store, pin));

    expect(result).toEqual({ outcome: "contended", attempts: MAX_RESET_ATTEMPTS });
    expect(store.reads).toBe(MAX_RESET_ATTEMPTS);
  });
});
