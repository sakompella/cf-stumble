import { describe, expect, it } from "vitest";

import type { GitObject } from "../../src/git/index.js";
import { decodeObject, encodeObject, FILE_MODE, parseSha } from "../../src/git/index.js";

const encoder = new TextEncoder();

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

    expect(decodeObject(encoded)).toEqual({ type: "blob", data });
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

    expect(decodeObject(encodeObject(object))).toEqual(object);
  });
});

describe("git object round trips", () => {
  it("preserves every generated object", () => {
    for (const object of generatedObjects()) {
      expect(decodeObject(encodeObject(object))).toEqual(object);
    }
  });
});

describe("malformed git objects", () => {
  it("rejects an object whose header length does not match its body", () => {
    const bytes = encoder.encode("blob 4\0abc");

    expect(() => decodeObject(bytes)).toThrow(/declares 4 bytes, got 3/u);
  });

  it("rejects a tree with an unsupported mode", () => {
    const body = concat(
      encoder.encode("040000 nested\0"),
      shaBytes("0123456789012345678901234567890123456789"),
    );

    expect(() => decodeObject(concat(encoder.encode(`tree ${body.byteLength}\0`), body))).toThrow(
      /invalid git tree entry mode/u,
    );
  });

  it("rejects a commit without a header separator", () => {
    const body = encoder.encode(
      "tree 0123456789012345678901234567890123456789\n" +
        "author Alice <alice@example.com> 0 +0000\n",
    );

    expect(() => decodeObject(concat(encoder.encode(`commit ${body.byteLength}\0`), body))).toThrow(
      /missing header separator/u,
    );
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
