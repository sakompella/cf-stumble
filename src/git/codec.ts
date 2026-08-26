import { assertNever } from "./types.js";
import type { GitObject } from "./types.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export function encodeObject(object: GitObject): Uint8Array {
  switch (object.type) {
    case "blob":
      return encodeBlob(object.data);
    case "tree":
    case "commit":
      throw new Error(`${object.type} encoding is not implemented yet`);
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

  const type = match[1];
  const lengthText = match[2];
  if (type === undefined || lengthText === undefined) {
    throw new TypeError("malformed git object header: missing type or length");
  }
  if (lengthText.length > 1 && lengthText.startsWith("0")) {
    throw new TypeError(
      `malformed git object header: non-canonical length ${lengthText}`,
    );
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
  if (type !== "blob") {
    throw new Error(`${type} decoding is not implemented yet`);
  }

  return { type: "blob", data: body.slice() };
}

function encodeBlob(data: Uint8Array): Uint8Array {
  return concat(textEncoder.encode(`blob ${data.byteLength}\0`), data);
}

function decodeUtf8(bytes: Uint8Array, context: string): string {
  try {
    return textDecoder.decode(bytes);
  } catch (error: unknown) {
    throw new Error(`malformed git object ${context}: invalid UTF-8`, {
      cause: error,
    });
  }
}

function concat(first: Uint8Array, second: Uint8Array): Uint8Array {
  const result = new Uint8Array(first.byteLength + second.byteLength);
  result.set(first);
  result.set(second, first.byteLength);
  return result;
}
