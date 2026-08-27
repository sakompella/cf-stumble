import { describe, expect, it } from "vitest";

import type {
  GitObject,
  GitObjectDecodeCondition,
  GitObjectDecodeError,
} from "../../src/git/index.js";
import { decodeObject, encodeObject, FILE_MODE, parseSha } from "../../src/git/index.js";
import { expectErr, expectOk } from "../support/result.js";

const encoder = new TextEncoder();
const SHA = parseSha("0123456789012345678901234567890123456789");

function decodeFailure(bytes: Uint8Array): GitObjectDecodeError {
  return expectErr(decodeObject(bytes));
}

function wrapped(type: string, body: Uint8Array): Uint8Array {
  return concat(encoder.encode(`${type} ${body.byteLength}\0`), body);
}

function expectTreeFailure(body: Uint8Array, condition: GitObjectDecodeCondition): void {
  expect(decodeFailure(wrapped("tree", body))).toMatchObject({ layer: "tree", condition });
}

/** One tree entry: the literal `"<mode> <name>\0"` prefix followed by twenty raw sha bytes. */
function treeEntry(prefix: string): Uint8Array {
  return concat(encoder.encode(prefix), shaBytes(SHA));
}

function shaBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

describe("git blob objects", () => {
  it("encodes an empty blob with its exact object header", () => {
    const encoded = encodeObject({ type: "blob", data: new Uint8Array() });

    expect(new TextDecoder().decode(encoded)).toBe("blob 0\0");
  });

  it("preserves binary blob content, including embedded NUL bytes", () => {
    const data = Uint8Array.from([0, 1, 2, 255, 0]);
    const encoded = encodeObject({ type: "blob", data });

    expect(expectOk(decodeObject(encoded))).toEqual({ type: "blob", data });
  });
});

describe("git tree objects", () => {
  it("encodes an empty tree", () => {
    const encoded = encodeObject({ type: "tree", entries: [] });

    expect(new TextDecoder().decode(encoded)).toBe("tree 0\0");
  });

  it("stores unpadded modes and raw twenty-byte object ids", () => {
    const sha = parseSha("0123456789012345678901234567890123456789");
    const encoded = encodeObject({
      type: "tree",
      entries: [{ mode: FILE_MODE.tree, name: "nested", sha }],
    });

    expect(encoded).toEqual(
      concat(encoder.encode("tree 33\0"), encoder.encode("40000 nested\0"), shaBytes(sha)),
    );
  });

  it("sorts a directory as if its name had a trailing slash", () => {
    const directorySha = parseSha("0123456789012345678901234567890123456789");
    const fileSha = parseSha("fedcba9876543210fedcba9876543210fedcba98");
    const encoded = encodeObject({
      type: "tree",
      entries: [
        { mode: FILE_MODE.tree, name: "foo", sha: directorySha },
        { mode: FILE_MODE.regular, name: "foo.txt", sha: fileSha },
      ],
    });

    expect(encoded).toEqual(
      concat(
        encoder.encode("tree 65\0"),
        encoder.encode("100644 foo.txt\0"),
        shaBytes(fileSha),
        encoder.encode("40000 foo\0"),
        shaBytes(directorySha),
      ),
    );
  });
});

describe("unicode git tree names", () => {
  it("round-trips unicode filenames", () => {
    const object = {
      type: "tree" as const,
      entries: [
        {
          mode: FILE_MODE.regular,
          name: "café.txt",
          sha: parseSha("0123456789012345678901234567890123456789"),
        },
      ],
    };

    expect(expectOk(decodeObject(encodeObject(object)))).toEqual(object);
  });
});

describe("git object round trips", () => {
  it("preserves every generated object", () => {
    for (const object of generatedObjects()) {
      expect(expectOk(decodeObject(encodeObject(object)))).toEqual(object);
    }
  });
});

/**
 * Every rejection is asserted by its `condition` rather than by its message, so the taxonomy is
 * what the test pins and rewording an error does not go red. The commit reader's conditions are
 * in `commit.test.ts`.
 */
describe("malformed git object headers", () => {
  it.each([
    ["no header terminator", encoder.encode("blob 4"), "missing-terminator"],
    ["a header that is not UTF-8", Uint8Array.of(255, 0), "invalid-utf8"],
    ["an unrecognised object type", encoder.encode("tag 0\0"), "malformed-header"],
    ["a zero-padded length", encoder.encode("blob 04\0abcd"), "non-canonical-length"],
    ["a length past 2^53", encoder.encode("blob 99999999999999999999\0"), "invalid-length"],
    ["a length that disagrees with the body", encoder.encode("blob 4\0abc"), "length-mismatch"],
  ] as const)("rejects %s", (_case, bytes, condition) => {
    expect(decodeFailure(bytes)).toMatchObject({ layer: "header", condition });
  });

  it("keeps the specifics on the developer-facing message", () => {
    const { _tag, message } = decodeFailure(encoder.encode("blob 4\0abc"));

    expect({ _tag, saysWhat: /declares 4 bytes, got 3/u.test(message) }).toEqual({
      _tag: "GitObjectDecodeError",
      saysWhat: true,
    });
  });
});

describe("malformed git trees", () => {
  it("rejects a tree entry whose mode has no separator", () => {
    expectTreeFailure(treeEntry("40000nested\0"), "missing-mode-separator");
  });

  it("rejects a tree with an unsupported mode", () => {
    expectTreeFailure(treeEntry("040000 nested\0"), "invalid-mode");
  });

  it("rejects a tree entry name with no terminator", () => {
    expectTreeFailure(encoder.encode("100644 nested"), "missing-name-terminator");
  });

  it("rejects a tree entry name that is not UTF-8", () => {
    const body = concat(concat(encoder.encode("100644 "), Uint8Array.of(255, 0)), shaBytes(SHA));

    expectTreeFailure(body, "invalid-utf8");
  });

  it("rejects an empty tree entry name", () => {
    expectTreeFailure(treeEntry("100644 \0"), "invalid-name");
  });

  it("rejects a tree entry with fewer than twenty sha bytes", () => {
    const body = concat(encoder.encode("100644 a\0"), shaBytes(SHA).subarray(0, 19));

    expectTreeFailure(body, "truncated-sha");
  });

  it("rejects a tree that names the same entry twice", () => {
    const entry = treeEntry("100644 a\0");

    expectTreeFailure(concat(entry, entry), "duplicate-entry-name");
  });

  // Out-of-order entries would give a content-addressed store a second name for an object that
  // already has one, so rejecting them is what keeps the address unique.
  it("rejects a tree whose entries are out of order", () => {
    const body = concat(treeEntry("100644 b\0"), treeEntry("100644 a\0"));

    expectTreeFailure(body, "unsorted-entries");
  });
});

function generatedObjects(): readonly GitObject[] {
  const treeSha = parseSha("0123456789012345678901234567890123456789");
  const parentSha = parseSha("1111111111111111111111111111111111111111");
  const objects: GitObject[] = [
    { type: "blob", data: new Uint8Array() },
    { type: "blob", data: Uint8Array.from([0, 1, 2, 255, 0]) },
    { type: "tree", entries: [] },
    {
      type: "tree",
      entries: [
        { mode: FILE_MODE.regular, name: "alpha", sha: treeSha },
        { mode: FILE_MODE.tree, name: "nested", sha: parentSha },
      ],
    },
    {
      type: "tree",
      entries: [
        { mode: FILE_MODE.regular, name: "café", sha: treeSha },
        { mode: FILE_MODE.regular, name: "内容", sha: parentSha },
      ],
    },
    generatedCommit(treeSha, [], "root 内容", -330),
    generatedCommit(treeSha, [parentSha], "child\nmessage", 530),
    generatedCommit(treeSha, [parentSha, treeSha], "merge\0message", -480),
  ];

  for (let index = 1; index <= 8; index += 1) {
    objects.push({ type: "blob", data: generatedBytes(index * 17, index * 3) });
  }
  return objects;
}

function generatedCommit(
  tree: ReturnType<typeof parseSha>,
  parents: readonly ReturnType<typeof parseSha>[],
  message: string,
  timezoneOffsetMinutes: number,
): GitObject {
  return {
    type: "commit",
    commit: {
      tree,
      parents,
      author: {
        name: "生成者",
        email: "author@example.com",
        timestamp: 1_700_000_000,
        timezoneOffsetMinutes,
      },
      committer: {
        name: "生成者",
        email: "committer@example.com",
        timestamp: 1_700_000_001,
        timezoneOffsetMinutes,
      },
      message,
    },
  };
}

function generatedBytes(seed: number, length: number): Uint8Array {
  const data = new Uint8Array(length);
  let state = seed;
  for (let index = 0; index < data.length; index += 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    data[index] = state & 255;
  }
  return data;
}
