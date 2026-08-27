import { describe, expect, it } from "vitest";

import type { GitObjectDecodeCondition } from "../../src/git/index.js";
import { decodeObject, encodeObject, parseSha } from "../../src/git/index.js";
import { expectErr, expectOk } from "../support/result.js";

const encoder = new TextEncoder();

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

describe("git root commit objects", () => {
  it("omits the parent header for a root commit", () => {
    const tree = parseSha("0123456789012345678901234567890123456789");
    const object = {
      type: "commit" as const,
      commit: {
        tree,
        parents: [],
        author: {
          name: "Alice Example",
          email: "alice@example.com",
          timestamp: 0,
          timezoneOffsetMinutes: 0,
        },
        committer: {
          name: "Alice Example",
          email: "alice@example.com",
          timestamp: 0,
          timezoneOffsetMinutes: 0,
        },
        message: "initial\n",
      },
    };
    const content = encoder.encode(
      "tree 0123456789012345678901234567890123456789\n" +
        "author Alice Example <alice@example.com> 0 +0000\n" +
        "committer Alice Example <alice@example.com> 0 +0000\n" +
        "\n" +
        "initial\n",
    );

    expect(encodeObject(object)).toEqual(
      concat(encoder.encode(`commit ${content.byteLength}\0`), content),
    );
    expect(expectOk(decodeObject(encodeObject(object)))).toEqual(object);
  });
});

describe("git merge commit objects", () => {
  it("encodes multiple parents and a negative non-whole-hour offset", () => {
    const object = {
      type: "commit" as const,
      commit: {
        tree: parseSha("0123456789012345678901234567890123456789"),
        parents: [
          parseSha("1111111111111111111111111111111111111111"),
          parseSha("2222222222222222222222222222222222222222"),
        ],
        author: {
          name: "Zoë",
          email: "zoe@example.com",
          timestamp: 1_700_000_000,
          timezoneOffsetMinutes: -330,
        },
        committer: {
          name: "Build Bot",
          email: "bot@example.com",
          timestamp: 1_700_000_001,
          timezoneOffsetMinutes: -480,
        },
        message: "merge: café\n\n内容",
      },
    };

    const encoded = encodeObject(object);
    expect(expectOk(decodeObject(encoded))).toEqual(object);
    expect(new TextDecoder().decode(encoded)).toContain("-0530");
    expect(new TextDecoder().decode(encoded)).toContain("merge: café\n\n内容");
  });
});

const TREE = "tree 0123456789012345678901234567890123456789\n";
const AUTHOR = "author Alice <alice@example.com> 0 +0000\n";
const COMMITTER = "committer Alice <alice@example.com> 0 +0000\n";

function expectCommitFailure(body: Uint8Array, condition: GitObjectDecodeCondition): void {
  const wrapped = concat(encoder.encode(`commit ${body.byteLength}\0`), body);

  expect(expectErr(decodeObject(wrapped))).toMatchObject({ layer: "commit", condition });
}

/** An author header carrying `rest` where a valid one carries `"<timestamp> <timezone>"`. */
function authoredWith(rest: string): string {
  return `author Alice <alice@example.com> ${rest}\n`;
}

/**
 * Every rejection the commit reader can produce, named by its `condition`. Each case is a whole
 * commit body that differs from a valid one in exactly the way the case is about, so a condition
 * firing for the wrong reason shows up as the wrong tag rather than as a pass.
 */
const MALFORMED_COMMITS = [
  ["no blank line before the message", `${TREE}${AUTHOR}${COMMITTER}`, "missing-separator"],
  ["no committer header", `${TREE}${AUTHOR}\nm`, "missing-header"],
  ["a header after the committer", `${TREE}${AUTHOR}${COMMITTER}${AUTHOR}\nm`, "unexpected-header"],
  ["an author where the tree belongs", `${AUTHOR}${AUTHOR}${COMMITTER}\nm`, "expected-header"],
  ["a tree that is not an object id", `tree nope\n${AUTHOR}${COMMITTER}\nm`, "invalid-sha"],
  ["a parent that is not an object id", `${TREE}parent x\n${AUTHOR}${COMMITTER}\nm`, "invalid-sha"],
  [
    "a signature with no timezone",
    `${TREE}${authoredWith("0")}${COMMITTER}\nm`,
    "invalid-signature",
  ],
  // The signature pattern is looser than the encoder: `(.+)` before the address happily takes an
  // angle bracket, which `encodeCommit` refuses to write back out.
  [
    "an angle bracket in an author name",
    `${TREE}author A>B <alice@example.com> 0 +0000\n${COMMITTER}\nm`,
    "invalid-identity",
  ],
  [
    "a timestamp past 2^53",
    `${TREE}${authoredWith("99999999999999999999 +0000")}${COMMITTER}\nm`,
    "invalid-timestamp",
  ],
  [
    "a timezone with more than 59 minutes",
    `${TREE}${authoredWith("0 +0060")}${COMMITTER}\nm`,
    "invalid-timezone",
  ],
  [
    "a negative-zero timezone, which git writes but we do not",
    `${TREE}${authoredWith("0 -0000")}${COMMITTER}\nm`,
    "non-canonical-timezone",
  ],
] as const;

describe("malformed git commits", () => {
  it("rejects a commit body that is not UTF-8", () => {
    expectCommitFailure(Uint8Array.of(255), "invalid-utf8");
  });

  it.each(MALFORMED_COMMITS)("rejects %s", (_case, text, condition) => {
    expectCommitFailure(encoder.encode(text), condition);
  });
});
