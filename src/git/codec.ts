import { assertNever } from "./types.js";
import type { GitObject, GitObjectType } from "./types.js";
import { concat, decodeUtf8, encodeUtf8 } from "./binary.js";
import { encodeCommit, decodeCommit } from "./commit.js";
import { encodeTree, decodeTree } from "./tree.js";

export function encodeObject(object: GitObject): Uint8Array {
  switch (object.type) {
    case "blob":
      return concat(encodeUtf8(`blob ${object.data.byteLength}\0`, "object header"), object.data);
    case "tree":
      return encodeTree(object.entries);
    case "commit":
      return encodeCommit(object.commit);
    default:
      return assertNever(object, "git object encoding");
  }
}

export function decodeObject(bytes: Uint8Array): GitObject {
  const headerEnd = bytes.indexOf(0);
  if (headerEnd < 0) {
    throw new Error("malformed git object: missing header terminator");
  }

  const header = decodeUtf8(bytes.subarray(0, headerEnd), "object header");
  const match = /^(blob|tree|commit) ([0-9]+)$/u.exec(header);
  if (match === null) {
    throw new Error(`malformed git object header: ${JSON.stringify(header)}`);
  }

  const typeText = match[1];
  const lengthText = match[2];
  if (typeText === undefined || lengthText === undefined) {
    throw new TypeError("malformed git object header: missing type or length");
  }
  if (lengthText.length > 1 && lengthText.startsWith("0")) {
    throw new TypeError(`malformed git object header: non-canonical length ${lengthText}`);
  }
  const length = Number(lengthText);
  if (!Number.isSafeInteger(length)) {
    throw new TypeError(`malformed git object header: invalid length ${lengthText}`);
  }

  const body = bytes.subarray(headerEnd + 1);
  if (body.byteLength !== length) {
    throw new Error(
      `malformed git object: header declares ${length} bytes, got ${body.byteLength}`,
    );
  }
  if (!isGitObjectType(typeText)) {
    throw new Error(`malformed git object: unknown type ${JSON.stringify(typeText)}`);
  }

  switch (typeText) {
    case "blob":
      return { type: "blob", data: body.slice() };
    case "tree":
      return decodeTree(body);
    case "commit":
      return decodeCommit(body);
    default:
      return assertNever(typeText, "git object decoding");
  }
}

function isGitObjectType(value: string): value is GitObjectType {
  return value === "blob" || value === "tree" || value === "commit";
}
