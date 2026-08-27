import type { TestCase } from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";

import { FILE_MODE, parseSha } from "../../src/git/index.js";
import type { Commit, GitObject, TreeEntry } from "../../src/git/index.js";

/**
 * Generators for the git object model, used by the property tests in `test/git/`.
 *
 * Every value leaves here through the module's own entry points — object ids come out of
 * `parseSha`, so the brand is applied by a type predicate rather than asserted (ADR-0015), and
 * modes come from `FILE_MODE` rather than string literals a typo could desynchronise.
 *
 * The generators stay inside what `src/git/types.ts` documents as the domain: names are non-empty
 * and free of `/` and NUL, identities carry no `<`, `>`, CR or LF, and timezone offsets are within
 * a real day. Those are the encoder's stated preconditions, so generating outside them would only
 * re-test that it throws, which `test/git/codec.test.ts` already pins by example.
 *
 * The `oracleSafe*` variants are narrower again, and only because isomorphic-git declines to go
 * where our encoder will — see the comments on each.
 */

/** 40 lowercase hex characters, narrowed by `parseSha` rather than branded by assertion. */
export const shas = gs
  .text({ alphabet: "0123456789abcdef", minSize: 40, maxSize: 40 })
  .map((hex) => parseSha(hex));

export const fileModes = gs.sampledFrom([
  FILE_MODE.regular,
  FILE_MODE.executable,
  FILE_MODE.symlink,
  FILE_MODE.tree,
]);

/**
 * Tree entry names. Lone surrogates are excluded (category `Cs`) because `encodeUtf8` rejects them
 * by contract; everything else the encoder claims to accept is in range, including names that are
 * prefixes of each other, which is where git's trailing-slash sort ordering bites.
 */
export const treeEntryNames = gs.oneOf(
  gs.sampledFrom(["a", "foo", "foo.txt", "foo0", "foo~", "内容", "café", "-", " ", "\u{1F600}"]),
  gs.text({ minSize: 1, maxSize: 8, excludeCharacters: "/\0", excludeCategories: ["Cs"] }),
);

/**
 * Names the oracle can be trusted on, for three different reasons.
 *
 * `.`, `..`, `.git` and its NTFS/HFS aliases are refused by git's own `verify_path`, and our
 * encoder accepts them — that is our bug, pinned as a counterexample in
 * `test/git/oracle.props.test.ts` rather than fixed here.
 *
 * The other two are the oracle's limits, not ours. A backslash is legal in a git tree entry but
 * isomorphic-git refuses it for Windows' sake. And `U+E000`–`U+FFFF` is excluded because
 * isomorphic-git orders tree entries with JavaScript string comparison, which is UTF-16 code-unit
 * order, while git orders them by UTF-8 bytes; the two disagree exactly when one name holds a
 * supplementary-plane character (a lead surrogate, `U+D800`–`U+DBFF`) and another holds one of
 * these. Supplementary-plane characters stay in — they are the interesting four-byte case, and
 * dropping the other side of the disagreement is enough.
 */
function isReadableByOracle(name: string): boolean {
  if (name.includes("\\") || /[\uE000-\uFFFF]/u.test(name)) return false;
  const cleaned = name
    .normalize("NFC")
    .toLowerCase()
    .replace(/[. ]+$/u, "");
  return name !== "." && name !== ".." && cleaned !== ".git" && !/^\.?git~[1-9]$/u.test(cleaned);
}

export const oracleSafeTreeEntryNames = treeEntryNames.filter((name) => isReadableByOracle(name));

/**
 * Build entries for a list of names, dropping repeats.
 *
 * Both our encoder and git itself reject a tree holding two entries of the same name, so a
 * duplicate would only re-test the rejection. `arrays({ unique: true })` is not enough on its own:
 * with a size drawn well above the size of a `sampledFrom` pool, hegel runs out of distinct values
 * and hands back repeats anyway (observed at roughly 2% of draws), so the invariant is enforced
 * here where it cannot be given up on.
 */
function entriesForNames(tc: TestCase, names: readonly string[]): readonly TreeEntry[] {
  const seen = new Set<string>();
  const entries: TreeEntry[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    entries.push({ mode: tc.draw(fileModes), name, sha: tc.draw(shas) });
  }
  return entries;
}

/** A tree's entries, in whatever order they were drawn. */
function treeEntriesOf(names: gs.Generator<string>): gs.Generator<readonly TreeEntry[]> {
  return gs.composite<readonly TreeEntry[]>((tc) => {
    const size = tc.draw(gs.integers({ minValue: 0, maxValue: 40 }));
    return entriesForNames(tc, tc.draw(gs.arrays(names, { minSize: size, unique: true })));
  });
}

export const treeEntries = treeEntriesOf(treeEntryNames);
export const oracleSafeTreeEntries = treeEntriesOf(oracleSafeTreeEntryNames);

/**
 * Trees whose entry names share a prefix — the only shape where git's trailing-slash rule changes
 * the order, since a directory `foo` sorts as `foo/` and so lands after the file `foo.txt`. Names
 * drawn independently collide on a prefix far too rarely to rely on, so these are built to collide.
 */
export const prefixSharingTreeEntries = gs.composite<readonly TreeEntry[]>((tc) => {
  const stem = tc.draw(gs.text({ minSize: 1, maxSize: 4, alphabet: "ab内" }));
  const suffixes = tc.draw(
    gs.arrays(gs.sampledFrom(["", ".", ".txt", "0", "~", "-", "\u{1F600}"]), {
      minSize: 1,
      unique: true,
    }),
  );
  return entriesForNames(
    tc,
    suffixes.map((suffix) => `${stem}${suffix}`),
  );
});

/** Identity text the encoder accepts: non-empty, and free of the delimiters it writes around. */
const identities = gs.text({
  minSize: 1,
  maxSize: 12,
  excludeCharacters: "<>\r\n",
  excludeCategories: ["Cs"],
});

const signatures = gs.composite((tc) => ({
  name: tc.draw(identities),
  email: tc.draw(identities),
  timestamp: tc.draw(gs.integers({ minValue: 0, maxValue: 2 ** 40 })),
  // `formatTimezone` documents this range; outside it the encoder throws by design.
  timezoneOffsetMinutes: tc.draw(gs.integers({ minValue: -1439, maxValue: 1439 })),
}));

function commitsOf(messages: gs.Generator<string>): gs.Generator<Commit> {
  return gs.composite<Commit>((tc) => ({
    tree: tc.draw(shas),
    parents: tc.draw(gs.arrays(shas, { maxSize: 4 })),
    author: tc.draw(signatures),
    committer: tc.draw(signatures),
    message: tc.draw(messages),
  }));
}

export const commits = commitsOf(gs.text({ maxSize: 40, excludeCategories: ["Cs"] }));

/**
 * isomorphic-git rewrites a commit message before hashing it — CRs dropped, leading and trailing
 * newlines collapsed to exactly one at the end — while our encoder stores what it is given. Every
 * message it would rewrite therefore produces two different, both-correct object ids, which says
 * nothing about the encoding. These are already in its normal form, so the comparison is about the
 * bytes rather than about whose normalisation wins.
 */
export const oracleSafeCommits = commitsOf(
  gs
    .text({ minSize: 1, maxSize: 40, excludeCategories: ["Cs"], excludeCharacters: "\r" })
    .map((message) => {
      const stripped = message.replaceAll(/^\n+|\n+$/gu, "");
      // A message that is only newlines strips to nothing, and isomorphic-git then drops the blank
      // line separating headers from body, which is a structural difference rather than an
      // encoding one.
      return `${stripped === "" ? "m" : stripped}\n`;
    }),
);

export const blobs = gs
  .binary({ maxSize: 512 })
  // On Node `binary()` hands back a `Buffer`, and a `Buffer` never compares equal to the plain
  // `Uint8Array` the decoder returns, which would fail round-trip properties for the wrong reason.
  .map((data) => ({ type: "blob", data: Uint8Array.from(data) }) satisfies GitObject);

export const gitObjects = gs.composite<GitObject>((tc) => {
  const kind = tc.draw(gs.sampledFrom(["blob", "tree", "commit"] as const));
  switch (kind) {
    case "blob":
      return tc.draw(blobs);
    case "tree":
      return { type: "tree", entries: tc.draw(treeEntries) };
    case "commit":
      return { type: "commit", commit: tc.draw(commits) };
    default:
      kind satisfies never;
      throw new Error("unreachable git object kind");
  }
});
