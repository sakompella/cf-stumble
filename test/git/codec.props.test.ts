import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { Result } from "better-result";
import { expect, test } from "vitest";

import { decodeObject, encodeObject } from "../../src/git/index.js";
import { gitObjects, treeEntries } from "../support/git-generators.js";
import { canonicalObject } from "../support/git-oracle.js";
import { expectOk } from "../support/result.js";

/**
 * A property layer over `test/git/codec.test.ts`, which round-trips a fixed list of objects. These
 * need no external oracle — each one holds the input it is checking against — so they stay
 * meaningful even where isomorphic-git declines to go.
 */

test("decoding undoes encoding for every object", () => {
  hegel.test((tc) => {
    const object = tc.draw(gitObjects);

    // A tree comes back in git's order rather than the order it was written in; that reordering
    // is the encoder's job, so it is part of the expected value, not a weakening of the property.
    expect(expectOk(decodeObject(encodeObject(object)))).toEqual(canonicalObject(object));
  });
});

test("re-encoding a decoded object is a fixpoint on the bytes", () => {
  hegel.test((tc) => {
    const encoded = encodeObject(tc.draw(gitObjects));

    // A format that drifts on the second pass still passes a one-shot round-trip, so check the
    // bytes settle rather than only that the value survives.
    expect(encodeObject(expectOk(decodeObject(encoded)))).toEqual(encoded);
  });
});

test("tree bytes do not depend on the order the entries were written in", () => {
  hegel.test((tc) => {
    const entries = tc.draw(treeEntries);
    const shuffled = [...entries];
    // Fisher-Yates driven by hegel, so a failing permutation shrinks to a minimal swap.
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swap = tc.draw(gs.integers({ minValue: 0, maxValue: index }));
      const here = shuffled[index];
      const there = shuffled[swap];
      if (here === undefined || there === undefined) throw new Error("bad shuffle index");
      shuffled[index] = there;
      shuffled[swap] = here;
    }

    expect(encodeObject({ type: "tree", entries: shuffled })).toEqual(
      encodeObject({ type: "tree", entries }),
    );
  });
});

/**
 * Bytes the decoder might accept: mostly single-byte mutations of a real encoding, because
 * uniform random bytes are rejected at the header and would never reach the tree or commit
 * parsers. `bytesReachDecoder` below asserts this generator keeps finding accepted inputs.
 */
const decoderInput = gs.composite<Uint8Array>((tc) => {
  if (tc.draw(gs.integers({ minValue: 0, maxValue: 9 })) === 0) {
    return tc.draw(gs.binary({ maxSize: 64 }));
  }
  const bytes = encodeObject(tc.draw(gitObjects));
  const mutations = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
  for (let count = 0; count < mutations; count += 1) {
    if (bytes.byteLength === 0) break;
    const at = tc.draw(gs.integers({ minValue: 0, maxValue: bytes.byteLength - 1 }));
    bytes[at] = tc.draw(gs.integers({ minValue: 0, maxValue: 255 }));
  }
  return bytes;
});

test("whatever the decoder accepts is canonical", () => {
  hegel.test((tc) => {
    const bytes = tc.draw(decoderInput);

    const decoded = decodeObject(bytes);
    if (Result.isError(decoded)) {
      // Rejection is always a valid answer, and since the migration it is the *only* way to fail:
      // the decoder returns its rejection, so anything that escapes as a throw from here is a
      // defect rather than malformed input, and hegel reports it as one.
      expect(decoded.error).toMatchObject({ _tag: "GitObjectDecodeError" });
      return;
    }

    // The store is content-addressed, so two byte strings that decode to the same object would be
    // two names for one thing. Accepting only canonical bytes is what rules that out.
    expect(encodeObject(decoded.value)).toEqual(bytes);
  });
});

test("mutated encodings still reach the decoder, so the property above is not vacuous", () => {
  let accepted = 0;
  hegel.test(
    (tc) => {
      if (Result.isOk(decodeObject(tc.draw(decoderInput)))) {
        accepted += 1;
      }
    },
    { testCases: 300 },
  );

  expect(accepted).toBeGreaterThan(0);
});
