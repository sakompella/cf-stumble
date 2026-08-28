import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, test } from "vitest";

import { MemoryStore } from "../../src/storage/memory.js";
import { persistedExamples } from "../support/hegel.js";
import { expectOk } from "../support/result.js";
import type { Sha } from "../../src/git/types.js";

/**
 * A property layer over `memory.test.ts`, which only wires `MemoryStore` into the shared store
 * conformance suite. `MemoryStore` is the address authority every generation manifest and pointer
 * move in this project is checked against, so its content-addressing contract is worth stating on
 * its own: the same bytes always find the same address, distinct bytes never share one, and a
 * write of something already present never grows the store.
 */

const blobs = gs.binary({ maxSize: 32 }).map((data) => Uint8Array.from(data));

/** An opaque grouping key for byte equality — not how the store computes an address, just a way
 * for the test to tell "same content" from "different content" without a `Map` keyed on bytes. */
function contentKey(bytes: Uint8Array): string {
  return JSON.stringify(Array.from(bytes));
}

test("writing the same bytes twice returns the same address, and reading it back returns those bytes", () =>
  hegel.testAsync(async (tc) => {
    const bytes = tc.draw(blobs);
    const store = new MemoryStore();

    const first = expectOk(await store.writeObject(bytes));
    const second = expectOk(await store.writeObject(bytes));

    expect(second).toBe(first);
    expect(expectOk(await store.readObject(first))).toEqual(bytes);
  }, persistedExamples));

test("distinct content never shares an address, and the store holds exactly one entry per distinct write", () =>
  hegel.testAsync(async (tc) => {
    const pool = tc.draw(gs.arrays(blobs, { minSize: 1, maxSize: 5 }));
    const writeOrder = tc.draw(
      gs.arrays(gs.integers({ minValue: 0, maxValue: pool.length - 1 }), {
        minSize: 1,
        maxSize: 20,
      }),
    );
    const store = new MemoryStore();
    const shaByContent = new Map<string, Sha>();

    for (const index of writeOrder) {
      const bytes = pool[index];
      if (bytes === undefined) throw new Error("write index out of range");
      const key = contentKey(bytes);
      const sha = expectOk(await store.writeObject(bytes));
      const seen = shaByContent.get(key);
      if (seen === undefined) {
        shaByContent.set(key, sha);
      } else {
        // Content the test already wrote once must come back to the exact same address, or the
        // store is not really content-addressed.
        expect(sha).toBe(seen);
      }
    }

    // If two different content keys had produced the same address, this set would be smaller than
    // the map it came from — that is what a real collision within one run looks like here.
    const distinctAddresses = new Set(shaByContent.values());
    expect(distinctAddresses.size).toBe(shaByContent.size);
    expect(expectOk(await store.listObjects())).toHaveLength(shaByContent.size);
  }, persistedExamples));
