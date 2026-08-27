import { describe, expect, it } from "vitest";

import { decodeObject, encodeObject, parseSha } from "../../src/git/index.js";

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
    expect(decodeObject(encodeObject(object))).toEqual(object);
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
    expect(decodeObject(encoded)).toEqual(object);
    expect(new TextDecoder().decode(encoded)).toContain("-0530");
    expect(new TextDecoder().decode(encoded)).toContain("merge: café\n\n内容");
  });
});
