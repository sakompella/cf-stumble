import * as hegel from "@hegeldev/hegel";
import { expect, test } from "vitest";

import { decodeObject, encodeObject, FILE_MODE, parseSha } from "../../src/git/index.js";
import {
  blobs,
  oracleSafeCommits,
  oracleSafeTreeEntries,
  prefixSharingTreeEntries,
} from "../support/git-generators.js";
import { assertOracleAgreement } from "../support/git-oracle.js";

/**
 * The differential layer over `test/git/oracle.test.ts`. That test pins three hand-chosen objects
 * against isomorphic-git; this runs the same four-way comparison — our id against theirs, our
 * bytes against theirs, our decoder on their bytes, their reader on our bytes — over generated
 * objects, which is what turns a handful of fixtures into a differential test against an
 * independent implementation of the format (ADR-0011).
 *
 * `src/git/` is 600-odd lines of hand-written byte-exact encoding whose output is hashed into a
 * content address, so a disagreement here is a wrong object id rather than a cosmetic difference.
 */

test("blob encoding agrees with isomorphic-git", () =>
  hegel.testAsync(async (tc) => {
    await assertOracleAgreement(tc.draw(blobs));
  }));

/**
 * Entry ordering and mode encoding are where this codec is most likely to be wrong: git sorts a
 * directory as though its name ended in `/`, and writes that mode unpadded as `40000` while
 * isomorphic-git's tree API spells the same mode `040000`. Neither convention is visible in a
 * round-trip test, because our encoder and our decoder would agree on a wrong answer.
 */
test("tree encoding agrees with isomorphic-git", () =>
  hegel.testAsync(async (tc) => {
    await assertOracleAgreement({ type: "tree", entries: tc.draw(oracleSafeTreeEntries) });
  }));

test("prefix-sharing tree names sort the way git sorts them", () =>
  hegel.testAsync(async (tc) => {
    await assertOracleAgreement({ type: "tree", entries: tc.draw(prefixSharingTreeEntries) });
  }));

test("commit encoding agrees with isomorphic-git", () =>
  hegel.testAsync(async (tc) => {
    await assertOracleAgreement({ type: "commit", commit: tc.draw(oracleSafeCommits) });
  }));

/**
 * A bug this suite found, pinned rather than fixed.
 *
 * `validateTreeNameBytes` in `src/git/tree.ts` rejects only an empty name, NUL and `/`. Git's own
 * `verify_path` also refuses `.`, `..`, `.git` and its NTFS/HFS aliases, and isomorphic-git
 * enforces that list when reading a tree — so `encodeObject` will happily produce a tree object
 * that real git tooling treats as corrupt, and `..` inside a tree is a path traversal on checkout,
 * which `parseWorkspacePath` rejects one layer up in `src/tools/`.
 *
 * The test asserts the behaviour as it stands, so it goes red the moment the encoder starts
 * rejecting the name and whoever fixes it has to come back and delete this.
 */
test("KNOWN BUG: the encoder writes tree entry names git refuses to read", async () => {
  const entries = [
    {
      mode: FILE_MODE.regular,
      name: ".",
      sha: parseSha("0000000000000000000000000000000000000000"),
    },
  ];

  expect(() => encodeObject({ type: "tree", entries })).not.toThrow();
  await expect(assertOracleAgreement({ type: "tree", entries })).rejects.toThrow(
    /contains unsafe character sequences/u,
  );
});

/**
 * The other disagreement this suite found, and here the oracle is the one that is wrong.
 *
 * Git orders tree entries by comparing raw bytes; isomorphic-git compares the names as JavaScript
 * strings, which is UTF-16 code-unit order. Those two orders differ exactly when one name holds a
 * supplementary-plane character — a surrogate pair, whose lead unit is `U+D800`–`U+DBFF` — and
 * another holds a character in `U+E000`–`U+FFFF`, because the second sorts after the first by code
 * unit and before it by byte. `oracleSafeTreeEntryNames` keeps the generated trees out of that
 * corner; this pins which side of it we are on.
 */
test("tree entries sort by UTF-8 bytes, where isomorphic-git sorts by UTF-16 code unit", () => {
  const sha = parseSha("0000000000000000000000000000000000000000");
  const entries = [
    { mode: FILE_MODE.regular, name: "\u{1F600}", sha },
    { mode: FILE_MODE.regular, name: "\uE000", sha },
  ];

  const decoded = decodeObject(encodeObject({ type: "tree", entries }));
  if (decoded.type !== "tree") throw new Error(`expected a tree, got ${decoded.type}`);

  // U+E000 is EE 80 80 and U+1F600 is F0 9F 98 80, so git puts U+E000 first. By code unit the
  // lead surrogate D83D is smaller, which is the order isomorphic-git would write.
  expect(decoded.entries.map((entry) => entry.name)).toEqual(["\uE000", "\u{1F600}"]);
});
