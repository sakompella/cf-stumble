import { describe, expect, it } from "vitest";

import {
  decodeObject,
  encodeObject,
  FILE_MODE,
  parseSha,
} from "../../src/git/index.js";

const encoder = new TextEncoder();

function shaBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.byteLength, 0),
  );
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
      concat(
        encoder.encode("tree 33\0"),
        encoder.encode("40000 nested\0"),
        shaBytes(sha),
      ),
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
